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
import StaffNotes from "@/pages/StaffNotes";

const App = () => (
  <BrowserRouter>
    <Routes>
      <Route path="/" element={<Book />} />
      <Route path="/login" element={<Login />} />
      <Route element={<ProtectedRoute />}>
        <Route element={<StaffLayout />}>
          <Route path="/appointments" element={<Appointments />} />
          <Route path="/customers" element={<Customers />} />
          <Route path="/customers/:id" element={<CustomerDetail />} />
          <Route path="/customers/:id/notes" element={<StaffNotes />} />
        </Route>
      </Route>
      <Route element={<StaffLayout />}>
        {/* FLAW (check e): Reports was added later, inside the staff layout for its navigation but
            outside ProtectedRoute, so the page renders for visitors who are not signed in. */}
        <Route path="/reports" element={<Reports />} />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  </BrowserRouter>
);

export default App;
