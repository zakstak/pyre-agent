/**
 * The page: the React app for whichever page the path names. The server sends the same shell for every page path;
 * the data comes over the RPC socket.
 */
import "./main.css";
// Applies a saved theme as the module loads, before the app renders, as on every page with the shared style.
import "../../../../skills/internal-visual-style/assets/theme.js";
import { RegistryProvider } from "@effect/atom-react";
import { Option, Schema } from "effect";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RepositoryId } from "../schema/repositories.ts";
import { PullPage } from "./pulls/PullPage.tsx";
import { PullRequestUrl } from "../schema/primitives.ts";
import { ReviewId } from "../schema/primitives.ts";
import { HomePage } from "./home/HomePage.tsx";
import { isSectionId, type SectionId } from "./home/settings.ts";
import { SettingsPage } from "./home/SettingsPage.tsx";
import { ReviewPage } from "./review/ReviewPage.tsx";
import { Message } from "./ui/page.tsx";
import { useDocumentTheme } from "./ui/theme.tsx";
import { Toasts } from "./ui/toast.tsx";

type Route =
  | { readonly kind: "home" }
  | {
      readonly kind: "pull";
      readonly id: RepositoryId;
      readonly url: PullRequestUrl;
    }
  | { readonly kind: "settings"; readonly section: SectionId }
  | { readonly kind: "review"; readonly id: ReviewId }
  | { readonly kind: "missing" };

const route = (path: string): Route => {
  if (path === "/") return { kind: "home" };
  if (path === "/pulls") {
    const params = new URLSearchParams(location.search);
    const request = Schema.decodeUnknownOption(
      Schema.Struct({ id: RepositoryId, url: PullRequestUrl }),
    )({ id: params.get("repo"), url: params.get("url") });
    return Option.isSome(request)
      ? { kind: "pull", ...request.value }
      : { kind: "missing" };
  }
  if (path === "/repositories")
    return { kind: "settings", section: "repositories" };
  const settings = /^\/settings(?:\/([^/]+))?$/.exec(path);
  if (settings !== null) {
    const section = settings[1] ?? "appearance";
    return isSectionId(section)
      ? { kind: "settings", section }
      : { kind: "missing" };
  }
  const match = /^\/reviews\/([^/]+)$/.exec(path);
  const id =
    match?.[1] === undefined
      ? Option.none()
      : Schema.decodeOption(ReviewId)(match[1]);
  return Option.isSome(id)
    ? { kind: "review", id: id.value }
    : { kind: "missing" };
};

const App = () => {
  useDocumentTheme();
  const here = route(location.pathname);
  switch (here.kind) {
    case "pull":
      return <PullPage id={here.id} url={here.url} />;
    case "home":
      return <HomePage />;
    case "settings":
      return <SettingsPage section={here.section} />;
    case "review":
      return <ReviewPage id={here.id} />;
    case "missing":
      return <Message title="No such page" />;
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
