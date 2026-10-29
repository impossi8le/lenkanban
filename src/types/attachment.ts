export interface Attachment {
  url: string;
  name: string;
  size: number;
  mime: string;
  width?: number;
  height?: number;
}

export type AttachmentArray = Attachment[];
