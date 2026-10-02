import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";

const NotFound = () => (
  <div className="flex min-h-screen flex-col items-center justify-center gap-4">
    <h1 className="text-2xl font-semibold">Page not found</h1>
    <Button asChild variant="outline">
      <Link to="/">Back to booking</Link>
    </Button>
  </div>
);

export default NotFound;
