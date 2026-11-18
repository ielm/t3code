# Canvases

A canvas is an interactive page an agent builds beside the chat, in the right panel. Unlike a [visual reply](html-renders.md), it stays open, the agent keeps updating it as the work moves, and what you do in it goes back to the agent. Ask for one ("keep a board of these steps", "give me a table I can sort and tick", "build me a dashboard for this") or let the agent reach for it when a wall of text would serve you worse.

Canvases work on web and desktop. A thread can have up to eight, each in its own tab.

## What happens when you use one

- Controls that only change the view, such as sorting, filtering or switching tabs, respond at once and cost nothing.
- A control the page marks as sending to the agent, such as a Submit or Approve button, goes straight to the thread as a message. There is no confirmation. If the agent is busy, the message waits its turn.
- A canvas can show live data and take actions on your machine without the agent, through functions the agent declares for it. See below.

Closing a canvas tab only hides it. Find it again under Canvases in the panel's `+` menu, or ask the agent to show it. A canvas is removed when the agent closes it or the thread is deleted.

## Functions

A canvas is a folder of files. Its `canvas.json` can declare functions, each a command the page may run on the machine the environment runs on:

```json
{
  "title": "Service dashboard",
  "functions": {
    "status": { "command": ["bash", "functions/status.sh"], "kind": "read" },
    "restart": { "command": ["bash", "functions/restart.sh"], "kind": "change" }
  }
}
```

- A `read` function may run whenever the page asks, including on a timer. Use it for live data.
- A `change` function runs only as a direct result of your click or key press in the canvas. A page cannot trigger one on its own.
- Functions run in the thread's workspace with your user's permissions, the same as the agent's own commands. Nothing a canvas does not declare can run.
- A function that writes files into its own canvas folder reloads the page, because the folder is watched. Write elsewhere.

The page itself has no network access. Everything it shows from outside comes through its functions or from the agent.

## Saving and reusing

Right-click a canvas tab to save it:

- **Save to project** puts it in `.canvases/` at the workspace root, so it is versioned with the repository and available in every thread of that project.
- **Save to personal library** puts it in `canvases/` in your T3 home folder, available in every project. Set `T3CODE_CANVAS_LIBRARY_DIR` to keep the library somewhere else, such as a repository of your own.

Saving copies the page and its functions, never its current data. Saved canvases appear under Canvases in the `+` menu; opening one makes a fresh copy in the thread that you and the agent can change freely. Agents can also list, open and save canvases themselves.

A saved canvas can share pieces with others. Files in its `parts/` folder can be imported by any other canvas page at `~lib/<project|personal>/<name>/parts/<file>`.
