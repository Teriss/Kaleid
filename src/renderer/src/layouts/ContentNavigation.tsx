import { createContext, useContext, type ReactNode } from "react";
export const ContentNavigationContext = createContext<{
  content: ReactNode;
  title: string;
} | null>(null);
export const useContentNavigation = () => useContext(ContentNavigationContext);
