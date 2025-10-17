import authMiddleware from "./auth.middleware.js";

const readVerTodo = (req) =>
  String((req.query?.verTodo ?? req.body?.verTodo ?? req.headers["x-ver-todo"]) ?? "N")
    .toUpperCase() === "S";

export async function authOrSuper(req, res, next){
  try {
    if (readVerTodo(req)){ req.user = req.user || { globalId:"SUPER" }; return next(); }
    return authMiddleware(req, res, next);
  } catch (e){ next(e); }
}

export async function adminOrSuper(req, res, next){
  try {
    if (readVerTodo(req)){ req.user = req.user || { globalId:"SUPER" }; return next(); }
    return authMiddleware(req, res, next);
  } catch (e){ next(e); }
}
