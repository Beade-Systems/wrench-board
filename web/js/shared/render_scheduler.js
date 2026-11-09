/** Coalesce view changes into one frame; an idle viewer schedules no work. */
export function createRenderScheduler(render) {
  let frame = null;
  let disposed = false;
  return {
    request() {
      if (disposed || frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        render();
      });
    },
    dispose() {
      disposed = true;
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
    },
  };
}
