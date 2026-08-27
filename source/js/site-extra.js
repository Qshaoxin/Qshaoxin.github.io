/* 作者卡闲置 5 秒自动翻面为相册轮播 */
(function () {
  function initIdleCarousel() {
    var car = document.getElementById("card-album-carousel");
    var card = car && car.closest(".card-widget.card-info");
    if (!car || !card || car.dataset.bound) return;
    var photos = [];
    try { photos = JSON.parse(car.dataset.photos || "[]"); } catch (e) {}
    if (!photos.length) return;
    car.dataset.bound = "1";
    var timer = null, carTimer = null, idx = 0, showing = false;
    var img = car.querySelector(".carousel-img");
    var cap = car.querySelector(".carousel-cap");
    function showCarousel() {
      if (showing) return;
      showing = true;
      card.classList.add("card-show-album");
      carTimer = setInterval(function () {
        idx = (idx + 1) % photos.length;
        img.style.opacity = "0";
        setTimeout(function () {
          img.src = photos[idx].u;
          if (cap) cap.textContent = photos[idx].n || "";
          img.style.opacity = "1";
        }, 350);
      }, 3200);
    }
    function hideCarousel() {
      showing = false;
      card.classList.remove("card-show-album");
      clearInterval(carTimer);
    }
    function resetTimer() {
      if (showing) hideCarousel();
      clearTimeout(timer);
      timer = setTimeout(function () {
        if (!card.matches(":hover")) showCarousel();
      }, 5000);
    }
    card.addEventListener("mouseenter", function () { clearTimeout(timer); if (showing) hideCarousel(); });
    card.addEventListener("mouseleave", resetTimer);
    card.addEventListener("click", resetTimer);
    card.addEventListener("touchstart", resetTimer, { passive: true });
    resetTimer();
  }
  initIdleCarousel();
  window.addEventListener("load", initIdleCarousel);
  document.addEventListener("pjax:complete", initIdleCarousel);
})();

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
