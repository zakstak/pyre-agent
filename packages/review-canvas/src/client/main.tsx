/**
 * The page: the React app for whichever page the path names. The server sends the same shell for every page path;
 * the data comes over the RPC socket.
 */
import "./main.css";
import { RegistryProvider } from "@effect/atom-react";
import { Option, Schema } from "effect";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ReviewId } from "../schema/primitives.ts";
import { HomePage } from "./home/HomePage.tsx";
import { ReviewPage } from "./review/ReviewPage.tsx";
import { useDocumentTheme } from "./ui/theme.tsx";
import { Toasts } from "./ui/toast.tsx";

type Route = { readonly kind: "home" } | { readonly kind: "review"; readonly id: ReviewId } | { readonly kind: "missing" };

const route = (path: string): Route => {
  if (path === "/") return { kind: "home" };
  const match = /^\/reviews\/([^/]+)$/.exec(path);
  const id = match?.[1] === undefined ? Option.none() : Schema.decodeOption(ReviewId)(match[1]);
  return Option.isSome(id) ? { kind: "review", id: id.value } : { kind: "missing" };
};

const App = () => {
  useDocumentTheme();
  const here = route(location.pathname);
  switch (here.kind) {
    case "home":
      return <HomePage />;
    case "review":
      return <ReviewPage id={here.id} />;
    case "missing":
      return (
        <main className="mx-auto max-w-work p-8">
          <h1 className="text-title font-semibold">No such page</h1>
          <p className="mt-2 text-muted">
            <a className="text-link underline" href="/">
              Back to the review canvas
            </a>
          </p>
        </main>
      );
  }
};

const root = document.getElementById("root");
if (root !== null)
  createRoot(root).render(
    <StrictMode>
      <RegistryProvider>
        <Toasts>
          <App />
        </Toasts>
      </RegistryProvider>
    </StrictMode>,
  );
