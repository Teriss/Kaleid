export function runtime(): Promise<{
  list(): any[];
  provider(id: string): any;
  register(provider: any): void;
  unregister(id: string): void;
}>;
