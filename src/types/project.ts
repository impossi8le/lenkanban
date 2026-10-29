export interface Project {
  id: string;
  name: string;
  description: string | null;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
  boardRevision: number;
  dndV2Enabled: boolean;
  owner?: {
    id: string;
    email: string;
    name: string | null;
    avatarUrl: string | null;
  };
  _count?: {
    tasks?: number;
    members?: number;
  };
  columns?: ProjectColumn[];
  tags?: Tag[];
}

export interface ProjectColumn {
  id: string;
  projectId: string;
  name: string;
  color: string;
  position: number;
  status?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Tag {
  id: string;
  name: string;
  color: string;
  projectId: string;
  createdAt: string;
}

export interface ProjectMember {
  id: string;
  projectId: string;
  userId: string;
  role: "MEMBER" | "PROJECT_ADMIN";
  createdAt: string;
  user: {
    id: string;
    email: string;
    name: string | null;
    avatarUrl: string | null;
  };
}
