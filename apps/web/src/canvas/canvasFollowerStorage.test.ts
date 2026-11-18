import { describe, expect, it } from "vite-plus/test";

import { followCanvases } from "./canvasFollower";
import {
  readCanvasFollower,
  rememberCanvasFollower,
  writeCanvasFollower,
} from "./canvasFollowerStorage";

const follower = (revealIds: Record<string, string>) => ({ revealIds });

describe("rememberCanvasFollower", () => {
  it("moves a rewritten thread to the newest place and drops the oldest past the cap", () => {
    const stored = { a: follower({ plan: "r1" }), b: follower({}), c: follower({}) };

    const rewritten = rememberCanvasFollower(stored, "a", follower({ plan: "r2" }), 3);
    expect(Object.keys(rewritten)).toEqual(["b", "c", "a"]);
    expect(rewritten.a).toEqual(follower({ plan: "r2" }));

    const added = rememberCanvasFollower(rewritten, "d", follower({}), 3);
    expect(Object.keys(added)).toEqual(["c", "a", "d"]);
  });
});

describe("canvas follower storage", () => {
  it("has nothing for a thread this client has not seen", () => {
    expect(readCanvasFollower("env-1:never-seen")).toBeNull();
  });

  it("restores what was written, so a reload opens only what was revealed while away", () => {
    const threadKey = "env-1:thread-reload";
    const seen = followCanvases({
      follower: readCanvasFollower(threadKey),
      canvases: [{ name: "plan", revealId: "r1" }],
      openTabs: new Set(),
    });
    expect(seen.actions).toEqual([]);
    writeCanvasFollower(threadKey, seen.follower);

    const restored = readCanvasFollower(threadKey);
    expect(restored).toEqual(follower({ plan: "r1" }));
    const afterReload = followCanvases({
      follower: restored,
      canvases: [
        { name: "plan", revealId: "r1" },
        { name: "board", revealId: "r7" },
      ],
      openTabs: new Set(),
    });
    expect(afterReload.actions).toEqual([{ type: "open", name: "board" }]);
  });

  it("keeps a thread seen without canvases apart from one never seen", () => {
    const threadKey = "env-1:thread-empty";
    writeCanvasFollower(threadKey, follower({}));

    expect(readCanvasFollower(threadKey)).toEqual(follower({}));
  });
});
