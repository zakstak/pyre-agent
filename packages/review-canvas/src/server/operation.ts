/** One start/upgrade operation at a time, including foreground starts and destructive builds. */
import { runtimeDir } from "./paths.ts";
import { secureRuntimeDir, StartLock } from "./runtime.ts";

export const acquireOperationLock = async (): Promise<StartLock> => {
  const dir = runtimeDir();
  secureRuntimeDir(dir);
  for (let attempt = 0; attempt < 600; attempt++) {
    const lock = StartLock.try(dir, "commands.lock");
    if (lock !== undefined) return lock;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Another command is updating the server in ${dir}; retry when it finishes.`,
  );
};

export const withServerOperation = async <A>(
  run: () => Promise<A>,
): Promise<A> => {
  const lock = await acquireOperationLock();
  try {
    return await run();
  } finally {
    lock.release();
  }
};
