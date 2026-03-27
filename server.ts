import express from 'express';
import { createServer as createViteServer } from 'vite';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config({ path: '.env.local' });

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Initialize Supabase Client
// We use the Service Role Key on the server to bypass RLS and manage data securely
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('CRITICAL: Supabase environment variables are missing!');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '10mb' }));

  // API Routes
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', database: 'supabase' });
  });

  // Login API
  app.post('/api/login', async (req, res) => {
    const { username, password, role } = req.body;
    
    if (role === 'visitor') {
      const { data: visitor, error } = await supabase
        .from('visitors')
        .select('*')
        .eq('visitor_id', username)
        .single();

      if (visitor) {
        return res.json({ success: true, role: 'visitor', visitor_id: visitor.visitor_id });
      } else {
        return res.status(401).json({ error: 'Invalid Visitor ID' });
      }
    }

    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('username', username)
      .eq('password', password)
      .eq('role', role)
      .single();

    if (user) {
      res.json({ success: true, role: user.role, username: user.username });
    } else {
      res.status(401).json({ error: 'Invalid credentials' });
    }
  });

  // Visitors API
  app.post('/api/visitors', async (req, res) => {
    const { name, phone, age, id_proof_type, id_proof_number, purpose, host_name, department, photo } = req.body;
    
    const visitor_id = 'VIS' + Date.now().toString().slice(-6);
    const entry_time = new Date().toISOString();
    
    let status = 'Pending Approval';
    if (['Admission Enquiry', 'Campus Tour'].includes(purpose)) {
      status = 'Approved';
    }

    let host_location = null;
    if (host_name) {
      const { data: host } = await supabase
        .from('users')
        .select('location')
        .eq('username', host_name)
        .eq('role', 'host')
        .single();
      
      if (host) host_location = host.location;
    }

    const { data, error } = await supabase
      .from('visitors')
      .insert([
        { 
          visitor_id, 
          name, 
          phone, 
          age, 
          id_proof_type, 
          id_proof_number, 
          purpose, 
          host_name, 
          department, 
          entry_time, 
          status, 
          photo, 
          host_location 
        }
      ])
      .select();

    if (error) {
      console.error('Supabase Error:', error);
      return res.status(500).json({ error: 'Failed to register visitor' });
    }
    
    res.json({ success: true, visitor_id, status });
  });

  app.get('/api/visitors', async (req, res) => {
    const { data, error } = await supabase
      .from('visitors')
      .select('*')
      .order('entry_time', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  });

  app.get('/api/visitors/:id', async (req, res) => {
    const { data, error } = await supabase
      .from('visitors')
      .select('*')
      .eq('visitor_id', req.params.id)
      .single();

    if (error) return res.status(404).json({ error: 'Visitor not found' });
    res.json(data);
  });

  app.put('/api/visitors/:id/status', async (req, res) => {
    const { status } = req.body;
    const { id } = req.params;
    
    const updateData: any = { status };
    if (status === 'Completed') {
      updateData.exit_time = new Date().toISOString();
    }

    const { error } = await supabase
      .from('visitors')
      .update(updateData)
      .eq('visitor_id', id);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, status });
  });

  app.delete('/api/visitors/:id', async (req, res) => {
    const { error } = await supabase
      .from('visitors')
      .delete()
      .eq('visitor_id', req.params.id);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  });

  app.get('/api/dashboard/stats', async (req, res) => {
    try {
      const { count: active } = await supabase.from('visitors').select('*', { count: 'exact', head: true }).eq('status', 'Inside Campus');
      const { count: pending } = await supabase.from('visitors').select('*', { count: 'exact', head: true }).eq('status', 'Pending Approval');
      const { count: completed } = await supabase.from('visitors').select('*', { count: 'exact', head: true }).eq('status', 'Completed');
      const { count: total } = await supabase.from('visitors').select('*', { count: 'exact', head: true });
      
      const { data: allVisitors } = await supabase.from('visitors').select('purpose, department');
      
      const purposeStats = (allVisitors || []).reduce((acc: any, curr: any) => {
        acc[curr.purpose] = (acc[curr.purpose] || 0) + 1;
        return acc;
      }, {});

      const deptStats = (allVisitors || []).reduce((acc: any, curr: any) => {
        acc[curr.department] = (acc[curr.department] || 0) + 1;
        return acc;
      }, {});

      res.json({
        active: active || 0,
        pending: pending || 0,
        completed: completed || 0,
        total: total || 0,
        byPurpose: Object.entries(purposeStats).map(([purpose, count]) => ({ purpose, count })),
        byDepartment: Object.entries(deptStats).map(([department, count]) => ({ department, count }))
      });
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch stats' });
    }
  });

  // Host Management API
  app.get('/api/users/hosts', async (req, res) => {
    const { data, error } = await supabase
      .from('users')
      .select('id, username, role, location')
      .eq('role', 'host');

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  });

  app.post('/api/users/hosts', async (req, res) => {
    const { username, password, location } = req.body;
    const { error } = await supabase
      .from('users')
      .insert([{ username, password, role: 'host', location: location || null }]);

    if (error) {
      if (error.code === '23505') return res.status(400).json({ error: 'Username already exists' });
      return res.status(500).json({ error: error.message });
    }
    res.json({ success: true });
  });

  app.delete('/api/users/hosts/:id', async (req, res) => {
    const hostId = parseInt(req.params.id);
    console.log(`Attempting to delete host with ID: ${req.params.id} (parsed: ${hostId})`);
    
    if (isNaN(hostId)) {
      return res.status(400).json({ error: `Invalid Host ID: ${req.params.id}` });
    }

    try {
      // First delete related approvals to avoid foreign key constraint errors
      const { error: approvalError } = await supabase.from('approvals').delete().eq('host_id', hostId);
      if (approvalError) {
        console.error('Error deleting host approvals:', approvalError);
        return res.status(500).json({ error: `Database error (approvals): ${approvalError.message}` });
      }

      const { data, error } = await supabase
        .from('users')
        .delete()
        .eq('id', hostId)
        .eq('role', 'host')
        .select();

      if (error) {
        console.error('Delete Host Error:', error);
        return res.status(500).json({ error: `Database error (users): ${error.message}` });
      }

      if (!data || data.length === 0) {
        return res.status(404).json({ error: 'Host not found or already deleted' });
      }

      res.json({ success: true });
    } catch (err: any) {
      console.error('Unexpected error during host deletion:', err);
      res.status(500).json({ error: `Server error: ${err.message}` });
    }
  });

  app.put('/api/users/hosts/:id', async (req, res) => {
    const hostId = parseInt(req.params.id);
    if (isNaN(hostId)) {
      return res.status(400).json({ error: 'Invalid Host ID' });
    }

    const { username, password, location } = req.body;
    const updateData: any = { username, location: location || null };
    if (password) updateData.password = password;

    const { error } = await supabase
      .from('users')
      .update(updateData)
      .eq('id', hostId)
      .eq('role', 'host');

    if (error) {
      if (error.code === '23505') return res.status(400).json({ error: 'Username already exists' });
      return res.status(500).json({ error: error.message });
    }
    res.json({ success: true });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get('*', (req, res) => {
      res.sendFile(path.join(__dirname, 'dist/index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
