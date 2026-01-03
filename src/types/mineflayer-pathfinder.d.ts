import "mineflayer";

declare module "mineflayer" {
  interface Bot {
    pathfinder: {
      setMovements(movements: any): void;
      goto(goal: any): Promise<void>;
      stop(): void;
    };
  }
}
