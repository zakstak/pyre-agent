/** The home page: the reviews, filtered by a query, with what each needs from the reviewer. */
import { FolderGit2 } from "lucide-react";
import { TOUCH_TARGET } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { HomeLayout } from "./HomeLayout.tsx";
import { Reviews } from "./Reviews.tsx";

export const HomePage = () => (
  <HomeLayout
    failure="Could not load the reviews. Reload the page to try again."
    actions={
      <a href="/repositories" className={cn(TOUCH_TARGET, "inline-flex items-center gap-1 text-small no-underline hover:underline")}>
        <FolderGit2 aria-hidden="true" className="size-3.5" />
        Repositories
      </a>
    }
  >
    {(home) => <Reviews reviews={home.reviews} />}
  </HomeLayout>
);
