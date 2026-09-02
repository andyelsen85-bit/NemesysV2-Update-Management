import { Router, type IRouter } from "express";
import healthRouter from "./health";
import managementRouter from "./management";
import authRouter from "./auth";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/auth", authRouter);
router.use(managementRouter);

export default router;
