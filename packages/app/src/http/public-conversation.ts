import type { ConversationItem } from 'dagent-ai';

import type { Conversation } from '../database/repositories.js';
import { requireConversationState } from '../database/repositories.js';

export function publicConversationSummary(conversation: Conversation) {
  return {
    id: conversation.id,
    projectId: conversation.projectId,
    title: conversation.title,
    kind: conversation.kind,
    schemaVersion: conversation.schemaVersion,
    revision: conversation.revision,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  };
}

export function publicConversation(conversation: Conversation) {
  const state = requireConversationState(conversation);
  return {
    ...publicConversationSummary(conversation),
    conversation: publicConversationState(state),
  };
}

export function publicConversationState(conversation: ReturnType<typeof requireConversationState>) {
  return {
    ...conversation,
    items: conversation.items
      .filter((item) => item.visibility === 'user')
      .map(publicConversationItem),
  };
}

function publicConversationItem(item: ConversationItem) {
  if (item.type !== 'assistant') return item;
  return {
    id: item.id,
    ...(item.runId === undefined ? {} : { runId: item.runId }),
    type: item.type,
    content: item.content,
    refusal: item.refusal,
    ...(item.usage === undefined ? {} : { usage: item.usage }),
    scope: item.scope,
    visibility: item.visibility,
  };
}
