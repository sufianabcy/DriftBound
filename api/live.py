"""WebSocket hub: buffers ticks per run and fans them out about 10 times a second.

A run can produce hundreds of steps per second; the browser gets one message
per flush, so a fast stream cannot flood it. Each viewer has a small queue, and
a slow viewer loses old messages instead of slowing the run down.
"""

from __future__ import annotations

import asyncio

MAX_TICKS_PER_MESSAGE = 60
QUEUE_SIZE = 32


def thin(ticks: list[dict], limit: int = MAX_TICKS_PER_MESSAGE) -> list[dict]:
    """Keep every tick that carries an event, the last tick, and an even sample of the rest."""
    if len(ticks) <= limit:
        return ticks
    keep = {i for i, t in enumerate(ticks) if t["events"]}
    keep.add(len(ticks) - 1)
    room = max(0, limit - len(keep))
    if room:
        stride = len(ticks) / room
        keep.update(int(i * stride) for i in range(room))
    return [ticks[i] for i in sorted(keep)]


class Hub:
    def __init__(self) -> None:
        self._subscribers: dict[str, set[asyncio.Queue]] = {}
        self._pending: dict[str, list[dict]] = {}

    def subscribe(self, run_id: str) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=QUEUE_SIZE)
        self._subscribers.setdefault(run_id, set()).add(queue)
        return queue

    def unsubscribe(self, run_id: str, queue: asyncio.Queue) -> None:
        subs = self._subscribers.get(run_id)
        if subs is not None:
            subs.discard(queue)
            if not subs:
                del self._subscribers[run_id]
                self._pending.pop(run_id, None)

    def viewers(self, run_id: str) -> int:
        return len(self._subscribers.get(run_id, ()))

    def push(self, run_id: str, tick: dict) -> None:
        """Buffer a tick; dropped at once if nobody is watching."""
        if run_id in self._subscribers:
            self._pending.setdefault(run_id, []).append(tick)

    def flush(self, run_id: str, state: dict) -> None:
        """Send the buffered ticks plus the run's latest state as one message."""
        ticks = self._pending.pop(run_id, [])
        if run_id in self._subscribers:
            self.publish(run_id, {"type": "ticks", "ticks": thin(ticks), **state})

    def publish(self, run_id: str, message: dict) -> None:
        for queue in self._subscribers.get(run_id, ()):
            if queue.full():
                queue.get_nowait()  # drop the oldest message for a slow viewer
            queue.put_nowait(message)

    def close_run(self, run_id: str, message: dict) -> None:
        """Tell viewers the run is gone; their sockets close after this message."""
        self.publish(run_id, message)
        self._pending.pop(run_id, None)
