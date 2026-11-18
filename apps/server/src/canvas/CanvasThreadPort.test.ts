import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  type OrchestrationV2ThreadShell,
  type Project,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as CanvasThreadPort from "./CanvasThreadPort.ts";

const threadId = ThreadId.make("thread-1");
const projectId = ProjectId.make("project-1");

interface Fixture {
  /** `undefined` means the thread does not exist. */
  readonly worktreePath?: string | null;
  /** `undefined` means the project does not exist. */
  readonly workspaceRoot?: string;
  readonly sent?: Array<ThreadManagementService.ThreadManagementSendInput>;
  readonly sendFailure?: ThreadManagementService.ThreadManagementError;
}

const layerTest = (fixture: Fixture) =>
  CanvasThreadPort.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: (id) =>
            Effect.succeed(
              id !== threadId || fixture.worktreePath === undefined
                ? null
                : ({
                    id,
                    projectId,
                    worktreePath: fixture.worktreePath,
                  } as OrchestrationV2ThreadShell),
            ),
          sendToThread: (input) =>
            fixture.sendFailure === undefined
              ? Effect.sync(() => {
                  fixture.sent?.push(input);
                  return {} as ThreadManagementService.ThreadManagementSendResult;
                })
              : Effect.fail(fixture.sendFailure),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeed(
              fixture.workspaceRoot === undefined
                ? Option.none()
                : Option.some({ id: projectId, workspaceRoot: fixture.workspaceRoot } as Project),
            ),
        }),
        NodeCrypto.layer,
      ),
    ),
  );

it.effect(
  "delivers text as a queued user message from the server, with fresh ids each time",
  () => {
    const sent: Array<ThreadManagementService.ThreadManagementSendInput> = [];
    return Effect.gen(function* () {
      const port = yield* CanvasThreadPort.CanvasThreadPort;
      yield* port.deliver({ threadId, text: "first" });
      yield* port.deliver({ threadId, text: "second" });

      expect(sent).toMatchObject(
        ["first", "second"].map((text) => ({
          projectId,
          threadId,
          text,
          attachments: [],
          mode: "queue",
          createdBy: "user",
          creationSource: "server",
        })),
      );
      expect(new Set(sent.map((input) => input.commandId)).size).toBe(2);
      expect(new Set(sent.map((input) => input.messageId)).size).toBe(2);
    }).pipe(Effect.provide(layerTest({ worktreePath: null, sent })));
  },
);

const archived = new ThreadManagementService.ThreadManagementThreadArchivedError({ threadId });

it.effect.each([
  { label: "the thread is gone", fixture: {}, cause: undefined },
  {
    label: "the send is refused",
    fixture: { worktreePath: null, sendFailure: archived },
    cause: archived,
  },
] satisfies ReadonlyArray<{ label: string; fixture: Fixture; cause: unknown }>)(
  "fails delivery with delivery-failed when $label",
  ({ fixture, cause }) =>
    Effect.gen(function* () {
      const port = yield* CanvasThreadPort.CanvasThreadPort;
      const error = yield* port.deliver({ threadId, text: "hello" }).pipe(Effect.flip);
      expect(error.reason).toBe("delivery-failed");
      expect(error.cause).toBe(cause);
    }).pipe(Effect.provide(layerTest(fixture))),
);

it.effect.each([
  {
    label: "the thread's worktree",
    fixture: { worktreePath: "/worktrees/feature", workspaceRoot: "/repo" },
    expected: "/worktrees/feature",
  },
  {
    label: "the project's root for a thread without a worktree",
    fixture: { worktreePath: null, workspaceRoot: "/repo" },
    expected: "/repo",
  },
  { label: "not-found for a missing thread", fixture: { workspaceRoot: "/repo" }, expected: null },
  { label: "not-found for a missing project", fixture: { worktreePath: null }, expected: null },
] satisfies ReadonlyArray<{ label: string; fixture: Fixture; expected: string | null }>)(
  "resolves the workspace root to $label",
  ({ fixture, expected }) =>
    Effect.gen(function* () {
      const port = yield* CanvasThreadPort.CanvasThreadPort;
      const result = yield* port
        .workspaceRoot(threadId)
        .pipe(Effect.match({ onFailure: (error) => error.reason, onSuccess: (root) => root }));
      expect(result).toBe(expected ?? "not-found");
    }).pipe(Effect.provide(layerTest(fixture))),
);
