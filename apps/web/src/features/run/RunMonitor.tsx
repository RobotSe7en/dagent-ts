import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { subscribeRun } from '../../api/client.js';
import { useWorkspace } from '../../state/workspace.js';

export function RunMonitor() {
  const queryClient = useQueryClient();
  const { activeRunId, runConversationId, appendRunEvent, setRunStreamError } = useWorkspace();

  useEffect(() => {
    if (activeRunId === undefined) return;
    return subscribeRun(
      activeRunId,
      (event) => {
        setRunStreamError('');
        appendRunEvent(event);
        if (event.type === 'run-completed') {
          if (runConversationId !== undefined) {
            void queryClient.invalidateQueries({
              queryKey: ['conversation', runConversationId],
            });
          }
        }
      },
      () => {
        setRunStreamError('连接暂时中断，正在自动恢复事件流。');
      },
    );
  }, [activeRunId, appendRunEvent, queryClient, runConversationId, setRunStreamError]);

  return null;
}
