/** The deadline covers the entire pipeline, including persistence after native teardown. */
export async function boundedShutdown(
  cleanup: () => Promise<unknown>,
  finish: () => void,
  milliseconds = 5000,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve()
        .then(cleanup)
        .catch(() => {}),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    finish();
  }
}
