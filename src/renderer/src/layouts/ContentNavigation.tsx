import { createContext, useContext, type ReactNode } from "react";
export const ContentNavigationContext = createContext<{
  content: ReactNode;
  title: string;
  identity?: string;
  spineContent?: ReactNode;
  sourceKind?: "local" | "online";
  empty?: {
    message: string;
    action?: () => void;
    actionLabel?: string;
    loading?: boolean;
    requiresNavigation?: boolean;
  };
  filter?: { query: string; clear(): void };
} | null>(null);
export const useContentNavigation = () => useContext(ContentNavigationContext);
