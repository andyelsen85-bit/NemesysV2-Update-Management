import { Router, type IRouter } from "express";
import healthRouter from "./health";
import managementRouter from "./management";
import authRouter from "./auth";
import securityRouter from "./security";
import usersRouter from "./users";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/auth", authRouter);
router.use(securityRouter);
router.use(usersRouter);
router.use(managementRouter);

export default router;
