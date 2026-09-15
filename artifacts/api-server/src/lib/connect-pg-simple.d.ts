declare module "connect-pg-simple" {
  import type session from "express-session";

  interface Options {
    pool: unknown;
    tableName?: string;
    createTableIfMissing?: boolean;
  }

  type SessionStoreFactory = (sessionModule: typeof session) => new (options: Options) => session.Store;
  const connectPgSimple: SessionStoreFactory;
  export default connectPgSimple;
}