export type ChatAttachment = {
  url: string;
  name: string;
  size: number;
  mime: string;
  width?: number;
  height?: number;
};

export type ChatMessageDTO = {
  id: string;
  clientId: string | null;
  taskId: string;
  authorId: string;
  author: {
    id: string;
    email: string;
    name: string | null;
    avatarUrl: string | null;
  };
  version?: number;
  editedAt?: string | null;
  deletedAt?: string | null;
  canEdit?: boolean;
  canDelete?: boolean;
  contentText: string;
  attachments: ChatAttachment[];
  reactions: Record<string, string[]>; // { "👍": ["userId1", "userId2"] }
  mentions: string[]; // ["userId1", "userId2"]
  createdAt: string;
};

export type ChatTypingDTO = {
  taskId: string;
  userId: string;
  userName?: string | null;
  isTyping: boolean;
};
