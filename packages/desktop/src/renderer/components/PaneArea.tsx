// 分栏区（B3-2 拆分产物）：PaneArea（1/2/3 栏、拖拽落点、分栏头）。
// 原 App.tsx 第 548–613 行逐字搬入；状态与 controller 来自 ../app-shared。
import { useState } from 'react';
import { ConversationHeader } from './ConversationHeader.js';
import { ChatView } from './ChatView.js';
import { controller, dragState, useAppState } from '../app-shared.js';

export function PaneArea(): React.ReactNode {
  const state = useAppState();
  const [dragOverPane, setDragOverPane] = useState<number | null>(null);
  const panes = state.layout.panes;

  return (
    <main className="main panes">
      <div className="pane-toolbar">
        {[1, 2, 3].map((n) => (
          <button
            key={n}
            type="button"
            className={`pane-count${panes.length === n ? ' active' : ''}`}
            onClick={() => void controller.setPaneCount(n)}
          >
            {n} 栏
          </button>
        ))}
      </div>
      <div className="pane-row">
        {panes.map((pane, i) => {
          const sid = pane.sessionId;
          const session = sid !== null ? state.sessions.find((s) => s.id === sid) : undefined;
          return (
            <section
              key={i}
              className={`pane${dragOverPane === i ? ' drag-over' : ''}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOverPane(i);
              }}
              onDragLeave={() => setDragOverPane((cur) => (cur === i ? null : cur))}
              onDrop={(e) => {
                e.preventDefault();
                setDragOverPane(null);
                const fromEvent = (() => {
                  try {
                    const v = e.dataTransfer.getData('text/plain');
                    return v.length > 0 ? v : null;
                  } catch {
                    return null;
                  }
                })();
                const dragged = dragState.sessionId ?? fromEvent;
                if (dragged !== null) void controller.assignToPane(i, dragged);
                dragState.sessionId = null;
              }}
            >
              <div className="pane-head">
                <span className="pane-label">{session ? session.firstUserText || '(空会话)' : '空分栏'}</span>
                {sid !== null && (
                  <button type="button" className="pane-unbind" onClick={() => void controller.assignToPane(i, null)}>
                    ✕
                  </button>
                )}
              </div>
              {sid !== null && session !== undefined && <ConversationHeader sessionId={sid} cwd={session.cwd} />}
              <ChatView streamId={sid} />
            </section>
          );
        })}
      </div>
    </main>
  );
}
