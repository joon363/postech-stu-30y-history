// BookScan Studio Mobile Shutter Logic
let currentPageNum = 1;
let mobilePreset = 1;
let captureMode = 'native'; // 'native' or 'live'
let videoStream = null;
let intervalTimer = null;
let intervalSeconds = 4;
let countdownRemaining = 4;
let isUploading = false;
let audioCtx = null;

document.addEventListener('DOMContentLoaded', () => {
  checkSecurityContext();
  initMobile();
  setupEventListeners();
});

function checkSecurityContext() {
  const isSecure = window.isSecureContext || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  const banner = document.getElementById('banner-insecure-http');
  const redirectBtn = document.getElementById('btn-redirect-https');

  if (!isSecure && banner) {
    banner.style.display = 'block';
  }

  if (redirectBtn) {
    redirectBtn.onclick = () => {
      // Redirect to HTTPS port 8443
      const currentHost = window.location.hostname;
      window.location.href = `https://${currentHost}:8443/mobile`;
    };
  }
}

async function initMobile() {
  await fetchSessionInfo();
  initWebSocket();
}

// Remote Control WebSocket Connection
function initWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws`;

  try {
    const socket = new WebSocket(wsUrl);

    socket.onopen = () => {
      console.log('Remote control WebSocket connected to PC');
      const badge = document.getElementById('remote-status-badge');
      if (badge) badge.style.display = 'inline-block';
      showToast('노트북 원격 제어 연결됨 (PC에서 촬영 가능)', 'success');
    };

    socket.onmessage = async (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.action === 'snap') {
          console.log('Received remote snap trigger from PC!');
          if (data.preset) {
            mobilePreset = data.preset;
          }
          const presetName = mobilePreset === 2 ? '일반' : '연도';
          showToast(`📸 노트북에서 원격 촬영 신호 수신! (프리셋: ${presetName})`, 'info');

          if (captureMode !== 'live') {
            await setMode('live');
            setTimeout(() => {
              handleShutterClick();
            }, 500);
          } else {
            handleShutterClick();
          }
        }
      } catch (err) {
        console.error('Error handling WebSocket message:', err);
      }
    };

    socket.onclose = () => {
      const badge = document.getElementById('remote-status-badge');
      if (badge) badge.style.display = 'none';
      setTimeout(initWebSocket, 2500);
    };

    socket.onerror = () => {};
  } catch (err) {
    console.warn('WebSocket init error:', err);
  }
}

// 1. Fetch info from backend
async function fetchSessionInfo() {
  try {
    const res = await fetch('/api/info');
    const data = await res.json();
    if (data.book_title) {
      document.getElementById('mobile-book-title').textContent = data.book_title;
    }
    if (data.next_page_num) {
      currentPageNum = data.next_page_num;
      updatePageBadge();
    }
    if (data.current_preset) {
      mobilePreset = data.current_preset;
    }
  } catch (err) {
    console.error('Failed to fetch info:', err);
  }
}

function updatePageBadge() {
  document.getElementById('label-current-page').textContent = currentPageNum;
}

// 2. Synthesized Camera Shutter Sound & Haptic Feedback
function initAudio() {
  if (!audioCtx) {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (AudioContext) audioCtx = new AudioContext();
  }
}

function playShutterSound() {
  try {
    initAudio();
    if (!audioCtx) return;

    // Create snappy mechanical shutter click using noise buffer + filter
    const bufferSize = audioCtx.sampleRate * 0.08;
    const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    const noise = audioCtx.createBufferSource();
    noise.buffer = buffer;

    const filter = audioCtx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1200;

    const gain = audioCtx.createGain();
    gain.gain.setValueAtTime(0.7, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.08);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(audioCtx.destination);

    noise.start();
  } catch (e) {
    console.log('Audio playback error', e);
  }

  // Haptic feedback
  if (navigator.vibrate) {
    navigator.vibrate([40]);
  }
}

function playTickSound() {
  try {
    initAudio();
    if (!audioCtx) return;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = 800;
    gain.gain.setValueAtTime(0.2, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.04);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.05);
  } catch (e) {}

  if (navigator.vibrate) {
    navigator.vibrate([15]);
  }
}

// Camera & Lens State
let currentZoom = 1.0;
let availableCameras = [];
let currentCameraIndex = 0;
let activeTrack = null;
let imageCaptureInstance = null;

// 3. Camera Mode Switching
async function setMode(mode) {
  captureMode = mode;
  const tabNative = document.getElementById('tab-mode-native');
  const tabLive = document.getElementById('tab-mode-live');
  const videoEl = document.getElementById('camera-video-feed');
  const guideText = document.getElementById('guide-label-text');
  const lensBar = document.getElementById('lens-control-bar');
  const resBadge = document.getElementById('badge-resolution');

  if (mode === 'live') {
    tabLive.classList.add('active');
    tabNative.classList.remove('active');
    videoEl.style.display = 'block';
    if (lensBar) lensBar.style.display = 'flex';
    guideText.textContent = '실시간 1.0x 메인 카메라 뷰파인더';
    if (resBadge) resBadge.textContent = '50MP 1.0x 메인';
    await startLiveCamera();
  } else {
    tabNative.classList.add('active');
    tabLive.classList.remove('active');
    videoEl.style.display = 'none';
    if (lensBar) lensBar.style.display = 'none';
    guideText.textContent = '50MP 네이티브 기본 카메라 모드 (권장)';
    if (resBadge) resBadge.textContent = '50MP 기본 카메라';
    stopLiveCamera();
  }
}

async function discoverCameras() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoDevices = devices.filter(d => d.kind === 'videoinput');
    // Filter back / rear cameras
    const rearCameras = videoDevices.filter(d => {
      const label = (d.label || '').toLowerCase();
      return !label.includes('front') && !label.includes('user') && !label.includes('전면');
    });

    availableCameras = rearCameras.length > 0 ? rearCameras : videoDevices;
    console.log('Discovered Cameras:', availableCameras);
    return availableCameras;
  } catch (e) {
    console.error('Error discovering cameras:', e);
    return [];
  }
}

async function startLiveCamera(targetDeviceId = null) {
  if (videoStream) stopLiveCamera();

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showToast('이 브라우저는 HTTP에서 카메라를 지원하지 않습니다. HTTPS 또는 USB(localhost)로 접속하세요.', 'error');
    setMode('native');
    return;
  }

  // 1. Discover cameras first
  await discoverCameras();

  // 2. Prioritize 1.0x Main Camera over 0.6x Ultra-Wide
  let selectedDeviceId = targetDeviceId;
  if (!selectedDeviceId && availableCameras.length > 0) {
    // If device labels exist, search for main/wide (avoid ultra/0.6x)
    const mainCam = availableCameras.find(c => {
      const l = c.label.toLowerCase();
      return (l.includes('wide') || l.includes('main') || l.includes('1x') || l.includes('back 0') || l.includes('camera2 0')) && !l.includes('ultra');
    });

    if (mainCam) {
      selectedDeviceId = mainCam.deviceId;
    } else if (availableCameras.length > 1) {
      // On many Galaxy phones, camera 0 is ultra-wide and camera 1 is 1x main!
      selectedDeviceId = availableCameras[0].deviceId;
    }
  }

  // 3. Constraints targeting 50MP (8192x6144 / 4K UHD) and 1.0x zoom
  const constraints = {
    video: {
      deviceId: selectedDeviceId ? { exact: selectedDeviceId } : undefined,
      facingMode: selectedDeviceId ? undefined : { ideal: 'environment' },
      width: { ideal: 8192, min: 1920 },
      height: { ideal: 6144, min: 1080 },
      advanced: [{ zoom: 1.0 }]
    },
    audio: false
  };

  try {
    videoStream = await navigator.mediaDevices.getUserMedia(constraints);
    const videoEl = document.getElementById('camera-video-feed');
    videoEl.srcObject = videoStream;
    await videoEl.play();

    activeTrack = videoStream.getVideoTracks()[0];

    // Initialize ImageCapture for native 50MP stills
    if (window.ImageCapture) {
      try {
        imageCaptureInstance = new ImageCapture(activeTrack);
      } catch (e) {
        imageCaptureInstance = null;
      }
    }

    // Force 1.0x zoom if hardware camera supports optical zoom
    await applyZoom(1.0);

    // Update label
    const camLabel = activeTrack.label || '1.0x 메인';
    const shortLabel = camLabel.length > 16 ? camLabel.substring(0, 14) + '..' : camLabel;
    const nameEl = document.getElementById('label-cam-name');
    if (nameEl) nameEl.textContent = shortLabel;

    const resBadge = document.getElementById('badge-resolution');
    if (resBadge) {
      const w = videoEl.videoWidth || 8192;
      const h = videoEl.videoHeight || 6144;
      resBadge.textContent = `50MP (${w}×${h})`;
    }

    showToast('1.0배 50MP 메인 카메라가 연결되었습니다!', 'success');
  } catch (err) {
    console.error('Camera access failed with 50MP constraints, retrying with flexible constraints:', err);
    try {
      // Fallback with standard environment
      videoStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840, min: 1280 } },
        audio: false
      });
      const videoEl = document.getElementById('camera-video-feed');
      videoEl.srcObject = videoStream;
      await videoEl.play();
      activeTrack = videoStream.getVideoTracks()[0];
      await applyZoom(1.0);
      showToast('1.0배 카메라 연결 완료 (기본 해상도)', 'success');
    } catch (fallbackErr) {
      showToast('카메라 권한 오류. [고화질 모드]를 사용하세요.', 'error');
      setMode('native');
    }
  }
}

async function applyZoom(zoomFactor) {
  currentZoom = zoomFactor;
  highlightLensButton(zoomFactor);

  if (!activeTrack) return;
  const caps = activeTrack.getCapabilities ? activeTrack.getCapabilities() : {};

  if (caps.zoom) {
    const minZ = caps.zoom.min || 0.6;
    const maxZ = caps.zoom.max || 10.0;
    const clamped = Math.max(minZ, Math.min(maxZ, zoomFactor));
    try {
      await activeTrack.applyConstraints({
        advanced: [{ zoom: clamped }]
      });
      console.log(`Applied zoom: ${clamped}x (Hardware min: ${minZ}, max: ${maxZ})`);
    } catch (e) {
      console.warn('Failed to apply zoom constraint:', e);
    }
  }
}

function highlightLensButton(zoomVal) {
  document.querySelectorAll('.lens-btn').forEach(btn => btn.classList.remove('active'));
  let targetId = 'btn-lens-10';
  if (zoomVal <= 0.8) targetId = 'btn-lens-06';
  else if (zoomVal >= 1.8) targetId = 'btn-lens-20';
  const targetBtn = document.getElementById(targetId);
  if (targetBtn) targetBtn.classList.add('active');
}

async function cycleNextCamera() {
  if (availableCameras.length <= 1) {
    await discoverCameras();
  }
  if (availableCameras.length <= 1) {
    showToast('전환 가능한 다른 후면 렌즈가 감지되지 않았습니다.', 'info');
    return;
  }

  currentCameraIndex = (currentCameraIndex + 1) % availableCameras.length;
  const nextCam = availableCameras[currentCameraIndex];
  showToast(`렌즈 전환: ${nextCam.label || 'Camera ' + currentCameraIndex}`, 'info');
  await startLiveCamera(nextCam.deviceId);
}

function stopLiveCamera() {
  if (videoStream) {
    videoStream.getTracks().forEach(track => track.stop());
    videoStream = null;
    activeTrack = null;
    imageCaptureInstance = null;
  }
}

// 4. Shutter Trigger Action
async function handleShutterClick() {
  if (isUploading) return;
  playShutterSound();

  if (captureMode === 'live' && videoStream) {
    await captureFromLiveVideo();
  } else {
    // Native Camera
    const nativeInput = document.getElementById('input-native-camera');
    nativeInput.click();
  }
}

// Capture 50MP High-Resolution Still from WebRTC
async function captureFromLiveVideo() {
  const video = document.getElementById('camera-video-feed');
  const canvas = document.getElementById('snapshot-canvas');

  let photoBlob = null;
  let resolutionText = '';

  // 1. First priority: ImageCapture API for native 50MP sensor photo
  if (imageCaptureInstance) {
    try {
      let photoCaps = {};
      try { photoCaps = await imageCaptureInstance.getPhotoCapabilities(); } catch(e){}
      const targetW = photoCaps.imageWidth?.max || 8192;
      const targetH = photoCaps.imageHeight?.max || 6144;

      photoBlob = await imageCaptureInstance.takePhoto({
        imageWidth: targetW,
        imageHeight: targetH,
        fillLightMode: 'auto'
      });
      resolutionText = `50MP (${targetW}×${targetH})`;
    } catch (e) {
      console.warn('ImageCapture takePhoto failed, falling back to canvas', e);
      photoBlob = null;
    }
  }

  // 2. Fallback: Draw video frame to full canvas
  if (!photoBlob) {
    if (!video || !video.videoWidth) return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    photoBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.95));
    resolutionText = `${video.videoWidth}×${video.videoHeight}`;
  }

  if (photoBlob) {
    showToast(`📸 ${resolutionText} 사진 캡처 완료!`, 'success');
    await uploadCapturedBlob(photoBlob, `snap_${Date.now()}.jpg`);
  }
}

// Upload Blob / File
async function uploadCapturedBlob(blobOrFile, filename) {
  isUploading = true;
  showToast(`Page ${currentPageNum} 업로드 중...`, 'info');

  const formData = new FormData();
  formData.append('files', blobOrFile, filename);
  formData.append('page_number', currentPageNum.toString());
  formData.append('preset', (mobilePreset || 1).toString());
  formData.append('auto_ocr', 'true');

  try {
    const res = await fetch('/api/upload', {
      method: 'POST',
      body: formData
    });
    const data = await res.json();
    if (data.success) {
      showToast(`Page ${currentPageNum} 저장 완료! (OCR 자동 분석중)`, 'success');

      // Auto-increment page number
      currentPageNum++;
      updatePageBadge();

      // Double haptic confirmation
      if (navigator.vibrate) navigator.vibrate([30, 40, 30]);
    } else {
      showToast('업로드 실패: ' + (data.detail || '오류'), 'error');
    }
  } catch (err) {
    showToast('서버 통신 실패. Wi-Fi 연결을 확인하세요.', 'error');
  } finally {
    isUploading = false;
  }
}

// 5. Hands-Free Interval Auto-Shutter Mode
function toggleIntervalMode() {
  const btn = document.getElementById('btn-toggle-interval');
  const shutterBtn = document.getElementById('btn-mobile-shutter');
  const countdownEl = document.getElementById('interval-countdown');

  if (intervalTimer) {
    // Turn off
    clearInterval(intervalTimer);
    intervalTimer = null;
    btn.textContent = '⏱️ 자동(4초)';
    btn.classList.remove('btn-danger');
    shutterBtn.classList.remove('interval-active');
    countdownEl.classList.remove('show');
    showToast('자동 연속 촬영이 중지되었습니다.', 'info');
  } else {
    // Switch to live mode for hands-free shooting
    if (captureMode !== 'live') {
      setMode('live');
    }

    countdownRemaining = intervalSeconds;
    countdownEl.textContent = countdownRemaining;
    countdownEl.classList.add('show');
    btn.textContent = '⏹️ 중지';
    btn.classList.add('btn-danger');
    shutterBtn.classList.add('interval-active');
    showToast(`${intervalSeconds}초마다 자동 촬영을 시작합니다. 페이지를 넘겨주세요!`, 'info');

    intervalTimer = setInterval(async () => {
      countdownRemaining--;
      if (countdownRemaining > 0) {
        countdownEl.textContent = countdownRemaining;
        playTickSound();
      } else {
        countdownEl.textContent = '📸';
        await handleShutterClick();
        countdownRemaining = intervalSeconds;
        countdownEl.textContent = countdownRemaining;
      }
    }, 1000);
  }
}

// 6. Setup Event Listeners
function setupEventListeners() {
  // Mode tabs
  document.getElementById('tab-mode-native').onclick = () => setMode('native');
  document.getElementById('tab-mode-live').onclick = () => setMode('live');

  // Giant shutter button
  document.getElementById('btn-mobile-shutter').onclick = handleShutterClick;

  // Viewfinder tap to snap in live mode
  document.getElementById('viewfinder-container').onclick = (e) => {
    if (captureMode === 'live' && !intervalTimer) {
      handleShutterClick();
    }
  };

  // Native camera input change
  const nativeInput = document.getElementById('input-native-camera');
  nativeInput.onchange = async (e) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      await uploadCapturedBlob(files[0], files[0].name || `snap_${Date.now()}.jpg`);
      nativeInput.value = '';
    }
  };

  // Gallery bulk upload
  const galleryBtn = document.getElementById('btn-open-gallery');
  const galleryInput = document.getElementById('input-batch-gallery');
  galleryBtn.onclick = () => galleryInput.click();

  galleryInput.onchange = async (e) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    showToast(`${files.length}장 일괄 업로드 시작...`, 'info');
    for (let i = 0; i < files.length; i++) {
      await uploadCapturedBlob(files[i], files[i].name);
    }
    galleryInput.value = '';
    showToast('일괄 업로드가 완료되었습니다!', 'success');
  };

  // Page stepper buttons
  document.getElementById('btn-page-minus').onclick = () => {
    if (currentPageNum > 1) {
      currentPageNum--;
      updatePageBadge();
    }
  };

  document.getElementById('btn-page-plus').onclick = () => {
    currentPageNum++;
    updatePageBadge();
  };

  // Auto interval button
  document.getElementById('btn-toggle-interval').onclick = toggleIntervalMode;

  // Lens switcher buttons (0.6x, 1.0x 메인, 2.0x, 렌즈 전환)
  const lens06 = document.getElementById('btn-lens-06');
  const lens10 = document.getElementById('btn-lens-10');
  const lens20 = document.getElementById('btn-lens-20');
  const cycleBtn = document.getElementById('btn-cycle-cameras');

  if (lens06) lens06.onclick = (e) => { e.stopPropagation(); applyZoom(0.6); };
  if (lens10) lens10.onclick = (e) => { e.stopPropagation(); applyZoom(1.0); };
  if (lens20) lens20.onclick = (e) => { e.stopPropagation(); applyZoom(2.0); };
  if (cycleBtn) cycleBtn.onclick = (e) => { e.stopPropagation(); cycleNextCamera(); };
}

// Toast helper
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = 'toast';
  const icon = type === 'success' ? '✅' : (type === 'error' ? '⚠️' : 'ℹ️');
  toast.innerHTML = `<span>${icon}</span><span>${message}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s';
    setTimeout(() => toast.remove(), 300);
  }, 2800);
}
