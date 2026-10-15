/**
 * The settings page: the navigation beside one section. Appearance sets how the pages look; Repositories lists the
 * repositories on this machine with their checkouts and reviews, from the same snapshot the home page reads.
 */
import { useEffect } from "react";
import { cn } from "../ui/cn.ts";
import { frame, SkipLink, TopBar } from "../ui/page.tsx";
import { Appearance } from "../ui/theme.tsx";
import { Snapshot } from "./HomeLayout.tsx";
import { Repositories } from "./Repositories.tsx";
import { type SectionId, sectionOf } from "./settings.ts";
import { SettingsNav } from "./SettingsNav.tsx";

const Content = ({ section }: { readonly section: SectionId }) => {
  switch (section) {
    case "appearance":
      return <Appearance />;
    case "repositories":
      return (
        <Snapshot failure="Could not load the repositories. Reload the page to try again.">
          {(home) => <Repositories snapshot={home} />}
        </Snapshot>
      );
  }
};

export const SettingsPage = ({ section }: { readonly section: SectionId }) => {
  const { title } = sectionOf(section);
  useEffect(() => {
    document.title = `${title} · Settings · Review canvas`;
  }, [title]);
  return (
    <>
      <SkipLink />
      <TopBar width="home" place={<h1 className="font-semibold">Settings</h1>} />
      <div className={cn(frame({ width: "home" }), "grid gap-x-8 gap-y-6 pt-8 pb-16 md:grid-cols-[12rem_minmax(0,1fr)]")}>
        <SettingsNav current={section} />
        <main id="main" tabIndex={-1} className="min-w-0">
          <Content section={section} />
        </main>
      </div>
    </>
  );
};
