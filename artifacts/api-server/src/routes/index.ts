import { Router, type IRouter } from "express";
import { requireApiKey } from "../middleware/auth";
import healthRouter from "./health";
import vendorsRouter from "./vendors";
import menuRouter from "./menu";
import ordersRouter from "./orders";
import conversationsRouter from "./conversations";
import customersRouter from "./customers";
import paymentsRouter from "./payments";
import dashboardRouter from "./dashboard";
import webhookRouter from "./webhook";
import promotionsRouter from "./promotions";
import broadcastsRouter from "./broadcasts";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/vendors", requireApiKey, vendorsRouter);
router.use("/menu", requireApiKey, menuRouter);
router.use("/orders", requireApiKey, ordersRouter);
router.use("/conversations", requireApiKey, conversationsRouter);
router.use("/customers", requireApiKey, customersRouter);
router.use("/payments", requireApiKey, paymentsRouter);
router.use("/dashboard", requireApiKey, dashboardRouter);
router.use(webhookRouter);
router.use("/promotions", requireApiKey, promotionsRouter);
router.use("/broadcasts", requireApiKey, broadcastsRouter);

export default router;
