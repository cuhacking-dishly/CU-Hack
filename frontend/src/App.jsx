import { AnimatePresence, motion, MotionConfig } from "framer-motion";
import { BrowserRouter, Route, Routes, useLocation } from "react-router-dom";
import RouteEffects from "./components/RouteEffects.jsx";
import GoalEntryPage from "./pages/GoalEntryPage.jsx";
import LikedRecipesPage from "./pages/LikedRecipesPage.jsx";
import NotFoundPage from "./pages/NotFoundPage.jsx";
import RecipeDetailPage from "./pages/RecipeDetailPage.jsx";
import SwipeDeckPage from "./pages/SwipeDeckPage.jsx";

function AppRoutes() {
  const location = useLocation();

  return (
    <>
      <RouteEffects />
      <AnimatePresence mode="wait">
        <motion.div
          className="route-transition"
          key={location.pathname}
          data-route={location.pathname}
          initial={{ opacity: 0, x: 34 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -22 }}
          transition={{ duration: 0.38, ease: [0.16, 1, 0.3, 1] }}
        >
          <Routes location={location}>
            <Route path="/" element={<GoalEntryPage />} />
            <Route path="/deck" element={<SwipeDeckPage />} />
            <Route path="/liked" element={<LikedRecipesPage />} />
            <Route path="/recipe/:id" element={<RecipeDetailPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </motion.div>
      </AnimatePresence>
    </>
  );
}

function App() {
  return (
    <MotionConfig reducedMotion="user">
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </MotionConfig>
  );
}

export { AppRoutes };
export default App;
