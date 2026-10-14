/**
 * The repositories page: the repositories on this machine with their checkouts and reviews, and the scan form. It
 * reads the same snapshot as the home page.
 */
import { useEffect } from "react";
import { HomeLayout } from "./HomeLayout.tsx";
import { Repositories } from "./Repositories.tsx";

export const RepositoriesPage = () => {
  useEffect(() => {
    document.title = "Repositories · Review canvas";
  }, []);
  return (
    <HomeLayout
      place={<h1 className="font-semibold">Repositories</h1>}
      failure="Could not load the repositories. Reload the page to try again."
    >
      {(home) => <Repositories snapshot={home} />}
    </HomeLayout>
  );
};
