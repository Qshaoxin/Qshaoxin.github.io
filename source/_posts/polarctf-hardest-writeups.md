---
title: 挑硬骨头啃：PolarCTF 三道 500 分题全记录
date: 2026-09-03 16:50:00
categories:
  - CTF
tags:
  - CTF
  - Crypto
  - Misc
  - Reverse
  - Writeup
---

最近想测一测自己的极限，跑到 [PolarCTF](https://www.polarctf.com) 上开了个号，不看简单题，直接按「500 分档 + 解出人数最少」排序，专挑最难的啃。一天下来连下三城：一道 Crypto、一道 Misc、一道 Reverse，都是 500 分、全站只有几十人解出的题。这篇文章完整记录三道题的思路和踩过的坑，代码都是当时实际跑通的。

## 〇、先解决一个前置问题：怎么「高效地」做题

平台是个 Vue 单页应用，人肉点页面太慢了。我直接把前端 JS 拖下来分析了下，发现它是 CTFd 魔改的，API 全在 `/api/v1/` 下面：

- `GET /api/v1/challenges` 拉全部题目列表
- `POST /api/v1/challenges/attempt` 提交 flag
- 登录走的是标准 CTFd 的 `POST /login` 表单

中间踩了个小坑：登录成功后调 attempt，接口一直回 `Please login first`。查了半天会话没问题，最后在前端代码里找到原因——**CTFd 的写操作要带 `CSRF-Token` 请求头**，值就是 cookie 里的 `nonce`。加上头之后一路畅通，此后拉题、下附件、交 flag 全用 curl 脚本完成。

891 道题里 500 分档共 216 道未解，按解出人数升序排，最狠的一道（heap_mirage）全站只有 8 个人做出来。我挑了三道对口的：

| 题目 | 分类 | 解出人数 | 核心考点 |
| --- | --- | --- | --- |
| Shamir | Crypto | 26 | 未知素数的 Shamir 秘密分享 |
| 静默追踪 | Misc | 22 | 多文件关联取证（PNG LSB / WAV / 碎片重组） |
| 练习5 | Reverse | 19 | 逆向 + VeraCrypt 卷 + PyInstaller 脱壳 |

## 一、Shamir：素数丢了怎么办

**题目附件**：一个 `shamir.py` 和 11 个秘密分片。脚本核心逻辑如下：

```python
p = "XXX"   # 素数丢了
k = 5       # 门限：5 个分片可恢复
n = 11
coeffs = [secret] + [random.randint(1, p-1) for _ in range(k-1)]
for i in range(1, n+1):
    x = random.randint(1, p-1)
    y = sum(c * pow(x, j, p) for j, c in enumerate(coeffs)) % p
    shares.append((x, y))
```

标准 Shamir 秘密分享，flag 是多项式常数项 `c_0`。正常做法是拿 5 个分片做拉格朗日插值求 `f(0)`——**但模数 p 被删了**，插值根本无从下手。

### 关键观察

这是个经典攻击面：次数为 4 的多项式，任意 6 个点 `(x_i, y_i)` 应当满足线性关系

$$\sum_{j=0}^{4} c_j x_i^j - y_i \equiv 0 \pmod p$$

把 6 个分片拼成 6×6 矩阵（5 列 `x^j` 加一列 `-y`），这个矩阵的行列式在模 p 意义下**必为 0**，也就是说行列式是 p 的倍数。换不同的 6 元子集多算几个行列式，GCD 一挤，小因子除干净，p 就出来了。

行列式计算用裸的分数会爆精度，我直接手写了 Bareiss 无分数消元（整数域上精确整除，中间不出现分数）：

```python
def bareiss_det(mat):
    n = len(mat); M = [row[:] for row in mat]; sign = 1; prev = 1
    for k in range(n-1):
        # 选主元、消元，全程整数运算
        ...
        M[i][j] = (M[i][j]*M[k][k] - M[i][k]*M[k][j]) // prev
    return sign * M[n-1][n-1]

g = 0
for subset in combinations(range(11), 6):
    rows = [[shares[i][0]**j for j in range(5)] + [-shares[i][1]] for i in subset]
    g = gcd(g, abs(bareiss_det(rows)))

cand = g
for q in range(2, 100000):          # 剥小因子
    while cand % q == 0: cand //= q
# Miller-Rabin 验证 → p 是个 513 bit 素数
```

拿到 p 后就是教科书流程：任取 5 个分片在模 p 下做拉格朗日插值算 `f(0)`：

```python
secret = sum(ys[i] * num * pow(den, -1, p) for ...) % p
secret.to_bytes((secret.bit_length()+7)//8, 'big')
```

我额外做了自检：用恢复出的多项式反算剩下 6 个分片的 y 值，全部吻合——说明恢复是唯一的、正确的。

**Flag：`flag{shamir_p_recovery_test}`**，名字起得很诚实，考的就是 p 的恢复。这题数学不难，难在想到「行列式 GCD」这一步。

## 二、静默追踪：信息不在文件里，在文件的关系中

**题目附件**五个：`hint.txt`（就一句 "Nothing useful here. Just noise."）、`txt`（中文提示）、`noise.png`（192×192 噪点图）、`silence.wav`（11 秒静音）、`packet.zip`（5 个 32 字节左右的 `frame_0x.bin`）。

中文提示是本题的题眼：

> 信息并不在文件里，而在文件的关系中。噪声不是连续说话的，碎片的重量决定步伐。

### 1. 先看碎片：一个被打散的 ZIP

逐个 dump frame 文件，`frame_03.bin` 开头是 `PK\x03\x04`——ZIP 本地文件头，而且 flags/method 字段显示是 **stored（无压缩）**，文件名 9 字节，内容 45 字节；`frame_01.bin` 开头恰好是 `nal.txt==Qfm...`，拼起来文件名是 `final.txt`。也就是说五个碎片按某个顺序拼起来是一个完整 ZIP。但顺序不明，而且碎片里混了大量 `0x5A`（'Z'）填充。

### 2. WAV：一条重复了四千遍的消息

`silence.wav` 名为静音，实际整段都是 ±259 以内的微幅噪声。写脚本把非零采样聚成簇，发现一共 4368 个簇，内容几乎全部相同——同一条 **48 字节消息**重复了几千遍，中间偶尔被零样本切断。消息本体是乱码，先记下。

### 3. PNG：噪声里的指令书

`noise.png` 三万六千种颜色，肉眼看是纯噪点。抱着试一试的心态提了 R/G/B 三个通道的 LSB——**B 通道出货了**，开头就是 base64：

```
T1JERVI9MywxLDUsMiw0O1hLRVk9NUE7Tk9URT1ibHVlX2xzYl9zdGVwXzE7
```

解码：

```
ORDER=3,1,5,2,4;XKEY=5A;NOTE=blue_lsb_step_1;
```

全部对上了：**ORDER 是五个碎片的拼接顺序，XKEY=0x5A 就是那些 'Z' 填充的由来**（`0x00 ^ 0x5A = 'Z'`），「碎片的重量决定步伐」暗示碎片长度参与拼接。

### 4. 收网

按 3,1,5,2,4 拼好、整体异或 0x5A，得到完整 ZIP（本地头 + 中央目录 + EOCD 全齐），`final.txt` 内容 45 字节，CRC32 与 ZIP 头里记录的完全一致：

```
==QfmJneuV2cfNHMfFmY2dmb5JXZfdWYylndmtHdul3c
```

base64 不可能以 `==` 开头——**反转字符串**再解：

```
c3ludHtmdnlyYWdfZXJ5bmd2YmFfMHNfc2VuenJmfQ==  →  synt{fvyrag_eryngvba_0s_senzrf}
```

`synt` → `flag`，一眼 ROT13。

**Flag：`flag{silent_relation_0f_frames}`**（silent relation of frames，碎片间的静默关系，点题）。这题设计得很优雅：每个文件单独看都是噪声，三个文件互为钥匙。

## 三、练习5：一道题串起四个技术面

Reverse 分类，19 人解出。附件两个：`exe`（11KB 的 PE）和 `1`（30MB 的"数据文件"）。

### 1. 逆向：一个 mod 97 矩阵校验器

exe 只有 stdio 导入，没有文件 IO，说明 30MB 的文件它根本不读——它只是个密码校验器。用 capstone 写了个小脚本解析 PE 节表和 IAT，反汇编主函数，逻辑还原出来非常干净：

```
输入 a, b, c, d
[3a+2b mod 97] ^ 31  == 24
[5a+7b mod 97] ^ 31  == 24
[3c+2d mod 97] ^ 31  == 50
[5c+7d mod 97] ^ 31  == 65
全对 → "Success!"
```

两组二元一次方程模 97，行列式 `3×7-5×2=11`，可逆，直接爆破 97×97 也毫秒级出解：**a=12, b=34, c=38, d=14**。运行 `exe` 输入 `12 34 38 14`，输出 `Success!`——然后就没有然后了，flag 不在程序里。

### 2. 突破口：30MB 的文件是什么

`file 1` 只说是 data；熵扫描 7680 个 4KB 块全部均匀（均值 7.9546，方差 0.004）——要么纯随机，要么加密数据。查了下资料，30MB 正是 VeraCrypt 加密卷的典型规格。

本机没装 VeraCrypt，下载还接连碰壁：GitHub 直连超时，SourceForge 403，launchpad 404。最后通过 gh-proxy 镜像把官方 MSI 拉下来，`msiexec /a` 免安装解开。但挂载卷要内核驱动 + 管理员权限，我当前 shell 两者都没有。

**那就不用它，纯 Python 手撕 VeraCrypt**。协议资料是公开的，实现要点：

1. 卷头结构：前 64 字节盐 + 448 字节 XTS-AES 加密头；
2. 密钥推导：`PBKDF2-HMAC-SHA512(密码, 盐, 500000轮, 64字节)` → 两个 256bit XTS 密钥；
3. XTS 手写：tweak = AES-ECB(数据单元号)，每 16 字节块后 tweak 做 GF(2^128) 乘 α（溢出归约 0x87）；
4. 解密成功标志：明文头前 4 字节是 `VERA`。

密码候选挨个试，`12343814`（就是那四个数字连写）+ SHA512 直接命中：

```
PASSWORD: '12343814'  PRF: sha512
header magic: b'VERA'
```

### 3. 又见字节序陷阱

解析解密后的卷头又卡了半小时：VolumeSize 解出来是 0，加密区长度是个莫名其妙的 56321。反复核对才发现两个坑：

- 卷头里的 **CRC 字段是大端**存的（`<I` 解出 `0x78bdc8a3`，`>I` 才是正确的 `0xa3c8bd78`），用 CRC 反查主密钥位置才确认密钥区在 `hdr[192:448]`；
- **XTS 的数据单元号是从文件头起的绝对扇区号**，不是从数据区起的相对编号。数据区在 131072 偏移处，第一个数据扇区的 unit 是 256 不是 0。

修正后解出 FAT 引导扇区 `EB 3C 90 "MSDOS5.0"`，整个卷解开。手写 FAT16 解析（FAT 表跟簇链），根目录里躺着：

```
FLAG××~1.EXE  30624512 字节
```

### 4. PyInstaller 脱壳的三个坑

29MB 的"flag 抽取器"，文件头是 `50 4B 03 04`（ZIP 头）——出题人把 PE 头 `4D 5A 90 00` 抹成了 PK。换回 MZ 后按 PyInstaller 流程提取：

**坑一**：文件末尾的 MEI cookie 里，包长/TOC 偏移等字段全是大端（`pyver` 字段解出 312 = Python 3.12 才反应过来，LE 解出来是 0x38010000 这种天文数字）。

**坑二**：TOC 条目同样是网络字节序 `!iIIIBc`，用 LE 解析直接得到 5 亿多的"长度"。

**坑三**：解出来的 `images/` 目录里七张图（bg、卡牌、按钮）全是 picsum.photos 的随机图，EXIF 里没有 flag，LSB 也没有。真正的答案在 `main` 模块的游戏逻辑里——这是一个 Tkinter 抽卡游戏，flag 要跑起来玩游戏才出。

最终从提取出的主模块里拿到答案。

**Flag：`flag{youareright}`**——做对了四个环节它才说你 right：静态逆向拿密码、离线解 VeraCrypt、FAT 簇链提取、PyInstaller 脱壳，一环扣一环，我个人觉得是三道题里出得最好的一道。

## 四、小结

三道题三种滋味：

1. **Shamir** 考「知道算法之外的攻击面」——门限方案本身没坏，坏的是参数，那就从代数结构里把参数反挤出来；
2. **静默追踪** 考「关联思维」——出题人明说答案在关系里，每个文件都是别人的一把钥匙；
3. **练习5** 考「工程韧性」——没有现成工具（无管理员、无 VeraCrypt、无 pyinstxtractor）的情况下，协议读文档手写实现，三处字节序陷阱全是靠异常值倒推定位的。

通用的一条经验：**遇到解析结果"差一点不对"，先怀疑字节序，再怀疑偏移基准**（绝对/相对），这两个坑在这天的题里各埋了一次。

分数都是浮云，这种「一层一层捅到底」的过程才是做题的乐趣。下一批目标已经选好：全站只有 8 人解出的 heap_mirage 和另外两道 PWN——那三道需要动态调试环境，等我搭好再战。

挑战平台：[PolarCTF](https://www.polarctf.com)，题目都还在，感兴趣可以去试试。
