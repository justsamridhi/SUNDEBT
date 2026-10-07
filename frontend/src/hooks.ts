import { useEffect, useRef, useState, useCallback } from 'react';

// ─── Step counter using DeviceMotion peak detection ───
export function useStepCounter() {
  const [steps, setSteps] = useState(0);
  const [supported, setSupported] = useState(false);
  const lastMag = useRef(0);
  const rising = useRef(false);
  const active = useRef(false);
  const listener = useRef<((event: DeviceMotionEvent) => void) | null>(null);

  const start = useCallback(async (reset = true) => {
    if (reset) {
      setSteps(0);
      lastMag.current = 0;
      rising.current = false;
    }
    active.current = true;
    if (typeof DeviceMotionEvent === 'undefined') {
      setSupported(false);
      return false;
    }

    const permissionAwareEvent = DeviceMotionEvent as typeof DeviceMotionEvent & {
      requestPermission?: () => Promise<'granted' | 'denied'>;
    };
    if (permissionAwareEvent.requestPermission) {
      try {
        const permission = await permissionAwareEvent.requestPermission();
        if (permission !== 'granted') {
          active.current = false;
          setSupported(false);
          return false;
        }
      } catch {
        active.current = false;
        setSupported(false);
        return false;
      }
    }

    if (!active.current) return false;
    if (listener.current) window.removeEventListener('devicemotion', listener.current);

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
    listener.current = handler;
    window.addEventListener('devicemotion', handler);
    setSupported(true);
    return true;
  }, []);

  const stop = useCallback(() => {
    active.current = false;
    if (listener.current) {
      window.removeEventListener('devicemotion', listener.current);
      listener.current = null;
    }
  }, []);

  return { steps, supported, start, stop };
}

// ─── Visibility tracker ───
export function useVisibility() {
  const visibleMs = useRef(0);
  const hiddenMs = useRef(0);
  const lastChange = useRef(Date.now());
  const tracking = useRef(false);

  const start = useCallback((reset = true) => {
    if (reset) {
      visibleMs.current = 0;
      hiddenMs.current = 0;
    }
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
  const [error, setError] = useState<string | null>(null);
  const sensorRef = useRef<any>(null);

  const start = useCallback(() => {
    setLux(null);
    setError(null);
    if (!('AmbientLightSensor' in window)) {
      setSupported(false);
      return;
    }
    try {
      // @ts-ignore
      const sensor = new AmbientLightSensor({ frequency: 1 });
      sensor.addEventListener('reading', () => setLux(sensor.illuminance));
      sensor.addEventListener('error', (event: any) => {
        setError(event.error?.message ?? 'Ambient light sensor permission or access failed');
        setSupported(false);
        sensor.stop();
        sensorRef.current = null;
      });
      sensor.start();
      sensorRef.current = sensor;
      setSupported(true);
    } catch (caught) {
      setSupported(false);
      setError(caught instanceof Error ? caught.message : 'Ambient light sensor unavailable');
    }
  }, []);

  const stop = useCallback(() => {
    if (sensorRef.current) {
      try { sensorRef.current.stop(); } catch (_e) { /* ignore */ }
      sensorRef.current = null;
    }
  }, []);

  return { lux, supported, error, start, stop };
}

// ─── Camera luminance check ───
export function useCameraCheck() {
  const [supported] = useState(() => !!(navigator.mediaDevices?.getUserMedia));
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const requestRef = useRef<Promise<MediaStream> | null>(null);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
  }, []);

  const startCamera = useCallback(async (video: HTMLVideoElement) => {
    videoRef.current = video;
    setError(null);
    try {
      let stream = streamRef.current;
      if (!stream) {
        const request = requestRef.current ?? navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'environment', width: 320, height: 240 }
          });
        requestRef.current = request;
        try {
          stream = await request;
          streamRef.current = stream;
        } finally {
          if (requestRef.current === request) requestRef.current = null;
        }
      }
      video.srcObject = stream;
      await video.play();
      return true;
    } catch (caught) {
      stopCamera();
      setError(caught instanceof Error ? caught.message : 'Camera permission or access failed');
      return false;
    }
  }, [stopCamera]);

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

  return { supported, error, startCamera, measureLuminance, stopCamera };
}
