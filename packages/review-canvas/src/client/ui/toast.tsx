/**
 * A short message at the bottom of the page. Anything can raise one, inside React or out: the page's Effect code
 * says what an action did or why the server refused it.
 */
import { Toast } from "@base-ui/react/toast";
import { cn } from "./cn.ts";

const manager = Toast.createToastManager();

export type ToastKind = "info" | "danger";

/** The toast on screen. A new one replaces it, so only the latest message shows and is announced. */
let current: string | undefined;

export const toast = (message: string, kind: ToastKind = "info"): void => {
  if (current !== undefined) manager.close(current);
  current = manager.add({ description: message, type: kind, timeout: kind === "danger" ? 8000 : 3500 });
};

const List = () => {
  const { toasts } = Toast.useToastManager();
  return toasts.map((item) => (
    <Toast.Root
      key={item.id}
      toast={item}
      className={cn(
        "rounded-panel border bg-raised px-4 py-3 text-small text-ink shadow-lg",
        item.type === "danger" ? "border-danger" : "border-line",
      )}
    >
      <Toast.Description />
    </Toast.Root>
  ));
};

export const Toasts = ({ children }: { readonly children: React.ReactNode }) => (
  <Toast.Provider toastManager={manager} limit={1}>
    {children}
    <Toast.Portal>
      <Toast.Viewport className="fixed bottom-4 left-1/2 z-50 w-[min(36rem,calc(100vw-2rem))] -translate-x-1/2">
        <List />
      </Toast.Viewport>
    </Toast.Portal>
  </Toast.Provider>
);
