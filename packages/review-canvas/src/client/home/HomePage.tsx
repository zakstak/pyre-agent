/** The home page: the reviews, filtered by a query, with what each needs from the reviewer. */
import { Settings2 } from "lucide-react";
import { TOUCH_TARGET } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { HomeLayout } from "./HomeLayout.tsx";
import { PullRequests, StackWalkthroughs } from "./PullRequests.tsx";
import { Reviews } from "./Reviews.tsx";

export const HomePage = () => (
  <HomeLayout
    failure="Could not load the reviews. Reload the page to try again."
    actions={
      <a
        href="/settings"
        className={cn(
          TOUCH_TARGET,
          "inline-flex items-center gap-1 text-small no-underline hover:underline",
        )}
      >
        <Settings2 aria-hidden="true" className="size-3.5" />
        Settings
      </a>
    }
  >
    {(home) => (
      <>
        {home.stacks.length === 0 ? null : (
          <section aria-labelledby="stack-walkthroughs" className="mb-8">
            <h2
              id="stack-walkthroughs"
              className="mb-3 text-heading font-semibold"
            >
              Stack walkthroughs
            </h2>
            <StackWalkthroughs stacks={home.stacks} />
          </section>
        )}
        <PullRequests home={home} />
        <h2 className="mb-3 text-heading font-semibold">Local reviews</h2>
        <Reviews reviews={home.reviews} />
      </>
    )}
  </HomeLayout>
);
