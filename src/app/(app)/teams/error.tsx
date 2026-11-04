"use client";

import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";

// Catches unexpected errors on team pages. Known problems (database down,
// access denied) are handled inside the pages with clearer messages.
export default function TeamsError({ retry }: { error: unknown; retry: () => void }) {
  return (
    <Callout
      tone="danger"
      title="Something went wrong"
      actions={
        <Button size="sm" onClick={() => retry()}>
          Try again
        </Button>
      }
    >
      This page couldn’t be shown. Check the server log for details.
    </Callout>
  );
}
