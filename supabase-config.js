const SUPABASE_URL = 'https://hbqtwpqvjblhgwehqnij.supabase.co';
const SUPABASE_KEY = 'sb_publishable_gdZ9TdflWXyisTHjHyZd_g_xvmRBSE5';
const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
console.log('Supabase loaded:', !!supabaseClient);