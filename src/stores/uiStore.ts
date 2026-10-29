import { create } from 'zustand'

interface UIState {
  isSidebarCollapsed: boolean
  toggleSidebar: () => void
  setSidebarCollapsed: (collapsed: boolean) => void
  activeProjectId: string | null
  setActiveProject: (id: string | null) => void
}

export const useUIStore = create<UIState>((set) => ({
  isSidebarCollapsed: false,
  toggleSidebar: () => set((state: UIState) => ({ isSidebarCollapsed: !state.isSidebarCollapsed })),
  setSidebarCollapsed: (collapsed: boolean) => set({ isSidebarCollapsed: collapsed }),
  activeProjectId: null,
  setActiveProject: (id: string | null) => set({ activeProjectId: id }),
}))
