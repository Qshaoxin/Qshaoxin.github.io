/* 头像戳一戳翻面 + 提示文字 */
(function () {
  function initAvatarPoke() {
    document.querySelectorAll(".author-info-avatar").forEach(function (box) {
      if (!box.querySelector(".avatar-back")) {
        var back = document.createElement("div");
        back.className = "avatar-back";
        back.innerHTML = '<div class="avatar-back-text">🎉<br>被你戳到啦<br>谢谢来访~</div>';
        box.appendChild(back);
        box.addEventListener("click", function () { box.classList.toggle("flipped"); });
      }
    });
    document.querySelectorAll(".card-widget.card-info .author-info__description").forEach(function (d) {
      if (!document.getElementById("poke-hint")) {
        var h = document.createElement("div");
        h.id = "poke-hint";
        h.className = "poke-hint";
        h.textContent = "👆 戳一戳有惊喜";
        d.parentNode.insertBefore(h, d);
      }
    });
  }
  initAvatarPoke();
  window.addEventListener("load", initAvatarPoke);
  document.addEventListener("pjax:complete", initAvatarPoke);
})();
