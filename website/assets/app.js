(function () {
  "use strict";

  const scenes = window.EXO2EGOHOI_SCENES;
  const host = document.getElementById("scene-panels");
  const template = document.getElementById("scene-panel-template");
  const galleryStatus = document.getElementById("gallery-status");
  const defaultId = "s05_box_use_02_camera3_429_477";

  if (!Array.isArray(scenes) || scenes.length === 0 ||
      new Set(scenes.map((scene) => scene.id)).size !== scenes.length ||
      scenes.some((scene) => !Array.isArray(scene.videos) || scene.videos.length !== 7 ||
        !Array.isArray(scene.handMeshes) || scene.handMeshes.length !== 7 ||
        !Array.isArray(scene.handErrors) || scene.handErrors.length !== 5) ||
      !scenes.some((scene) => scene.id === defaultId)) {
    galleryStatus.textContent = "The scene manifest is missing or incomplete.";
    return;
  }

  let panel;
  let resumeOnVisible = false;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  class ScenePanel {
    constructor(initialId) {
      this.el = template.content.firstElementChild.cloneNode(true);
      this.el.id = "scene-panel";
      this.sceneTitle = this.el.querySelector(".scene-title");
      this.sceneTitle.id = "scene-panel-heading";
      this.el.setAttribute("aria-labelledby", "scene-panel-heading");
      this.playState = this.el.querySelector(".panel-play-state");
      this.status = this.el.querySelector(".playback-status");
      this.sceneSelect = this.el.querySelector(".scene-select");
      this.sceneCount = this.el.querySelector(".scene-count");
      this.playButton = this.el.querySelector(".play-pause");
      this.replayButton = this.el.querySelector(".replay");
      this.previousButton = this.el.querySelector(".previous-scene");
      this.nextButton = this.el.querySelector(".next-scene");
      this.timeline = this.el.querySelector(".timeline");
      this.timeDisplay = this.el.querySelector(".time-display");
      this.videos = [
        ...this.el.querySelectorAll(".comparison-video"),
        ...this.el.querySelectorAll(".hand-mesh-video"),
        ...this.el.querySelectorAll(".hand-error-video"),
      ];
      this.errorLabels = this.videos.map((video) => video.parentElement.querySelector(".video-error"));
      if (this.videos.length !== 18 || this.errorLabels.some((label) => !label)) {
        throw new Error("The scene panel's video layout is incomplete.");
      }
      this.sceneSelect.setAttribute("aria-label", "Choose a scene");
      this.timeline.setAttribute("aria-label", "Playback position for this scene");
      this.sceneIndex = 0;
      this.generation = 0;
      this.loading = false;
      this.playing = false;
      this.scrubbing = false;
      this.resumeAfterScrub = false;
      this.animationFrame = 0;
      this.lastSync = 0;
      this.duration = 4.9;
      this.loadErrorCount = 0;
      this.playAttempt = 0;
      this.activeLoads = new Map();
      this.fillSceneSelect();
      this.sceneIndex = scenes.findIndex((scene) => scene.id === initialId);
      this.bindControls();
      this.setButtonState();
      host.append(this.el);
    }

    usableVideos() {
      return this.videos.filter((video) => !video.error && video.readyState >= HTMLMediaElement.HAVE_METADATA);
    }

    setButtonState() {
      this.playButton.innerHTML = this.playing ? 'Pause <span aria-hidden="true">Ⅱ</span>' : 'Play <span aria-hidden="true">▶</span>';
      this.playButton.setAttribute("aria-label", this.playing ? "Pause scene videos" : "Play scene videos");
      this.playState.textContent = this.playing ? "Playing" : "Paused";
      this.playState.classList.toggle("is-playing", this.playing);
    }

    showTime(value) {
      const time = Math.min(this.duration, Math.max(0, Number(value) || 0));
      this.timeline.value = String(time);
      this.timeDisplay.textContent = `${time.toFixed(1)} / ${this.duration.toFixed(1)} s`;
    }

    pause() {
      this.playAttempt += 1;
      this.videos.forEach((video) => video.pause());
      this.playing = false;
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = 0;
      this.setButtonState();
    }

    seek(value) {
      const time = Math.max(0, Math.min(Number(value) || 0, this.duration - 0.02));
      this.usableVideos().forEach((video) => {
        try { video.currentTime = time; } catch (_) { /* The video is still loading. */ }
      });
      this.showTime(time);
    }

    tick(now) {
      if (!this.playing || this.scrubbing) return;
      const ready = this.usableVideos();
      if (ready.length) {
        const master = ready[0];
        this.showTime(master.currentTime);
        if (now - this.lastSync > 250) {
          ready.slice(1).forEach((video) => {
            if (Math.abs(video.currentTime - master.currentTime) > 0.14 && master.currentTime < this.duration - 0.2) {
              try { video.currentTime = master.currentTime; } catch (_) { /* Seek may be temporarily unavailable. */ }
            }
          });
          this.lastSync = now;
        }
      }
      this.animationFrame = requestAnimationFrame((time) => this.tick(time));
    }

    async play(auto = false) {
      if (this.loading) return;
      const ready = this.usableVideos();
      if (!ready.length) {
        this.status.textContent = "No video could be loaded for this scene.";
        return;
      }
      const token = this.generation;
      const attempt = ++this.playAttempt;
      const outcomes = await Promise.allSettled(ready.map((video) => video.play()));
      if (attempt !== this.playAttempt) return;
      if (token !== this.generation) {
        ready.forEach((video) => video.pause());
        return;
      }
      if (outcomes.some((outcome) => outcome.status === "rejected")) {
        this.pause();
        this.status.textContent = auto
          ? "Autoplay was blocked. Select Play to start this scene."
          : "Playback could not start for every video. Select Play to retry.";
        return;
      }
      this.playing = true;
      this.setButtonState();
      this.status.textContent = this.loadErrorCount
        ? `${this.loadErrorCount} video(s) could not be loaded. The remaining videos are available.` : "";
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = requestAnimationFrame((time) => this.tick(time));
    }

    readyVideo(video, source, errorLabel) {
      const cancelPrevious = this.activeLoads.get(video);
      if (cancelPrevious) cancelPrevious();
      errorLabel.hidden = true;
      video.pause();
      video.removeAttribute("src");
      video.load();
      return new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => finish(false), 18000);
        function complete(ok, showError = true) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          video.removeEventListener("loadeddata", onReady);
          video.removeEventListener("error", onError);
          if (this.activeLoads.get(video) === cancel) this.activeLoads.delete(video);
          if (showError) errorLabel.hidden = ok;
          resolve(ok);
        }
        const finish = complete.bind(this);
        function cancel() { finish(false, false); }
        function onReady() { finish(true); }
        function onError() { finish(false); }
        this.activeLoads.set(video, cancel);
        video.addEventListener("loadeddata", onReady);
        video.addEventListener("error", onError);
        video.src = source;
        video.load();
      });
    }

    async loadScene(index) {
      const available = scenes;
      this.sceneIndex = (index + available.length) % available.length;
      const scene = available[this.sceneIndex];
      const token = ++this.generation;
      this.loading = true;
      this.pause();
      this.playButton.disabled = true;
      this.replayButton.disabled = true;
      this.timeline.disabled = true;
      this.status.textContent = "Loading comparison, hand-mesh, and hand-error videos…";
      this.sceneTitle.textContent = scene.label;
      this.sceneCount.textContent = `Scene ${this.sceneIndex + 1} of ${available.length}`;
      this.sceneSelect.value = scene.id;
      this.duration = 4.9;
      this.timeline.max = "4.9";
      this.showTime(0);

      const sources = scene.videos.concat(scene.handMeshes.slice(1), scene.handErrors);
      const results = await Promise.all(this.videos.map((video, i) => this.readyVideo(video, sources[i], this.errorLabels[i])));
      if (token !== this.generation) return;
      this.loading = false;
      this.playButton.disabled = false;
      this.replayButton.disabled = false;
      this.timeline.disabled = false;
      const firstReady = this.usableVideos()[0];
      this.duration = firstReady && Number.isFinite(firstReady.duration) ? firstReady.duration : 4.9;
      this.timeline.max = String(this.duration);
      this.showTime(0);
      this.loadErrorCount = results.filter((ok) => !ok).length;
      this.status.textContent = this.loadErrorCount
        ? `${this.loadErrorCount} video(s) could not be loaded. The remaining videos are available.` : "";
      if (document.visibilityState === "hidden") {
        resumeOnVisible = true;
      } else if (reducedMotion.matches) {
        this.status.textContent = "Automatic playback is paused because reduced motion is enabled. Select Play to start.";
      } else {
        await this.play(true);
      }
    }

    fillSceneSelect() {
      this.sceneSelect.replaceChildren();
      scenes.forEach((scene) => {
        const option = document.createElement("option");
        option.value = scene.id;
        const datasetName = scene.dataset === "arctic-hoi" ? "ARCTIC-HOI" : "Ego-Exo4D";
        option.textContent = `${datasetName} · ${scene.label} · ${scene.id}`;
        this.sceneSelect.append(option);
      });
    }

    bindControls() {
      this.sceneSelect.addEventListener("change", () => {
        const index = scenes.findIndex((scene) => scene.id === this.sceneSelect.value);
        if (index >= 0) this.loadScene(index);
      });
      this.previousButton.addEventListener("click", () => this.loadScene(this.sceneIndex - 1));
      this.nextButton.addEventListener("click", () => this.loadScene(this.sceneIndex + 1));
      this.playButton.addEventListener("click", () => this.playing ? this.pause() : this.play());
      this.replayButton.addEventListener("click", () => { this.seek(0); this.play(); });
      const beginScrub = () => {
        if (this.scrubbing) return;
        this.resumeAfterScrub = this.playing;
        this.scrubbing = true;
        this.pause();
      };
      const endScrub = () => {
        if (!this.scrubbing) return;
        this.scrubbing = false;
        if (this.resumeAfterScrub) this.play();
      };
      this.timeline.addEventListener("pointerdown", beginScrub);
      this.timeline.addEventListener("input", () => { if (!this.scrubbing) beginScrub(); this.seek(this.timeline.value); });
      this.timeline.addEventListener("change", endScrub);
      this.timeline.addEventListener("pointerup", endScrub);
      this.timeline.addEventListener("keyup", endScrub);
      this.videos.forEach((video) => video.addEventListener("ended", () => {
        if (!this.playing || video !== this.usableVideos()[0]) return;
        this.pause();
        this.seek(0);
        this.play();
      }));
    }
  }

  try {
    panel = new ScenePanel(defaultId);
    galleryStatus.hidden = true;
    panel.loadScene(panel.sceneIndex);
  } catch (error) {
    galleryStatus.hidden = false;
    galleryStatus.textContent = "The scene gallery could not be initialized.";
    throw error;
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      resumeOnVisible = panel.playing || panel.loading;
      if (panel.playing) panel.pause();
    } else if (resumeOnVisible) {
      resumeOnVisible = false;
      if (!panel.loading && !reducedMotion.matches) panel.play(true);
    }
  });
})();
