import { useEffect, useRef, useState, useCallback } from 'react';

// ─── Step counter using DeviceMotion peak detection ───
export function useStepCounter() {
  const [steps, setSteps] = useState(0);
  const [supported, setSupported] = useState(false);
  const lastMag = useRef(0);
  const rising = useRef(false);
  const active = useRef(false);

  const start = useCallback(() => {
    setSteps(0);
    active.current = true;
    if (typeof DeviceMotionEvent === 'undefined') return;
    setSupported(true);

    const handler = (e: DeviceMotionEvent) => {
      if (!active.current) return;
      const a = e.accelerationIncludingGravity;
      if (!a || a.x == null || a.y == null || a.z == null) return;
      const mag = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
      const THRESHOLD = 12;
      if (rising.current && mag < lastMag.current) {
        if (lastMag.current > THRESHOLD) setSteps(s => s + 1);
        rising.current = false;
      } else if (mag > lastMag.current) {
        rising.current = true;
      }
      lastMag.current = mag;
    };
    window.addEventListener('devicemotion', handler);
    return () => window.removeEventListener('devicemotion', handler);
  }, []);

  const stop = useCallback(() => { active.current = false; }, []);

  return { steps, supported, start, stop };
}

// ─── Visibility tracker ───
export function useVisibility() {
  const visibleMs = useRef(0);
  const hiddenMs = useRef(0);
  const lastChange = useRef(Date.now());
  const tracking = useRef(false);

  const start = useCallback(() => {
    visibleMs.current = 0;
    hiddenMs.current = 0;
    lastChange.current = Date.now();
    tracking.current = true;
  }, []);

  const stop = useCallback(() => {
    if (!tracking.current) return;
    const now = Date.now();
    const elapsed = now - lastChange.current;
    if (document.hidden) hiddenMs.current += elapsed;
    else visibleMs.current += elapsed;
    tracking.current = false;
  }, []);

  useEffect(() => {
    const handler = () => {
      if (!tracking.current) return;
      const now = Date.now();
      const elapsed = now - lastChange.current;
      if (document.hidden) visibleMs.current += elapsed;
      else hiddenMs.current += elapsed;
      lastChange.current = now;
    };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, []);

  const getSeconds = useCallback(() => ({
    visible: Math.round(visibleMs.current / 1000),
    hidden: Math.round(hiddenMs.current / 1000),
  }), []);

  return { start, stop, getSeconds };
}

// ─── Ambient Light Sensor (optional) ───
export function useLightSensor() {
  const [lux, setLux] = useState<number | null>(null);
  const [supported, setSupported] = useState(false);
  const sensorRef = useRef<any>(null);

  const start = useCallback(() => {
    setLux(null);
    if (!('AmbientLightSensor' in window)) return;
    try {
      // @ts-ignore
      const sensor = new AmbientLightSensor({ frequency: 1 });
      sensor.addEventListener('reading', () => setLux(sensor.illuminance));
      sensor.addEventListener('error', () => { /* sensor unavailable */ });
      sensor.start();
      sensorRef.current = sensor;
      setSupported(true);
    } catch (_e) { /* not available */ }
  }, []);

  const stop = useCallback(() => {
    if (sensorRef.current) {
      try { sensorRef.current.stop(); } catch (_e) { /* ignore */ }
      sensorRef.current = null;
    }
  }, []);

  return { lux, supported, start, stop };
}

// ─── Camera luminance check ───
export function useCameraCheck() {
  const [supported] = useState(() => !!(navigator.mediaDevices?.getUserMedia));
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const startCamera = useCallback(async (video: HTMLVideoElement) => {
    videoRef.current = video;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: 320, height: 240 }
      });
      video.srcObject = stream;
      await video.play();
      streamRef.current = stream;
      return true;
    } catch (_e) {
      return false;
    }
  }, []);

  const measureLuminance = useCallback((): number | null => {
    const video = videoRef.current;
    if (!video || video.readyState < 2) return null;
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 48;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, 64, 48);
    const data = ctx.getImageData(0, 0, 64, 48).data;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) {
      sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
    return sum / (64 * 48);
  }, []);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
  }, []);

  return { supported, startCamera, measureLuminance, stopCamera };
}
