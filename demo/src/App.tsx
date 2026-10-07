import { BrowserRouter, Route, Routes } from "react-router-dom";
import ProtectedRoute from "@/components/ProtectedRoute";
import StaffLayout from "@/components/StaffLayout";
import Appointments from "@/pages/Appointments";
import Book from "@/pages/Book";
import CustomerDetail from "@/pages/CustomerDetail";
import Customers from "@/pages/Customers";
import Login from "@/pages/Login";
import NotFound from "@/pages/NotFound";
import Reports from "@/pages/Reports";
import ResetPassword from "@/pages/ResetPassword";
import StaffNotes from "@/pages/StaffNotes";

const App = () => (
  <BrowserRouter>
    <Routes>
      <Route path="/" element={<Book />} />
      <Route path="/login" element={<Login />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route element={<ProtectedRoute />}>
        <Route element={<StaffLayout />}>
          <Route path="/appointments" element={<Appointments />} />
          <Route path="/customers" element={<Customers />} />
          <Route path="/customers/:id" element={<CustomerDetail />} />
          <Route path="/customers/:id/notes" element={<StaffNotes />} />
          {/* Fixed (check e): Reports now sits inside ProtectedRoute like every other staff page. */}
          <Route path="/reports" element={<Reports />} />
        </Route>
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  </BrowserRouter>
);

export default App;
