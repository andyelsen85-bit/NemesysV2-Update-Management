import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { getSslSettings } from "./lib/ssl";

const app: Express = express();
app.set("trust proxy", true);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(async (req, res, next) => {
  try {
    const ssl = await getSslSettings();
    const forwardedProto = String(req.headers["x-forwarded-proto"] ?? (req.secure ? "https" : "http")).split(",")[0].trim();
    if (ssl?.forceHttps && forwardedProto !== "https" && req.path !== "/api/healthz") {
      res.redirect(308, `https://${req.get("host")}${req.originalUrl}`);
      return;
    }
    if (ssl?.hstsEnabled && forwardedProto === "https") {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    next();
  } catch (error) {
    next(error);
  }
});

app.use("/api", router);

export default app;
