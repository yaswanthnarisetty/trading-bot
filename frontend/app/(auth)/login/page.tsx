"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { setCookie } from "cookies-next";
import { Lock, Mail, Loader2, ArrowRight } from "lucide-react";

export default function LoginPage() {
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [remember, setRemember] = useState(true);

  const handleLogin = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");

    if (!email.trim() || !password) {
      setError("Please enter both email and password.");
      return;
    }

    setLoading(true);

    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: email, password }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => null);
        throw new Error(text || "Invalid credentials");
      }

      const data = await res.json();

      setCookie("token", data.token, {
        maxAge: remember ? 60 * 60 * 24 * 14 : 60 * 60 * 12,
        path: "/",
      });

      router.push("/dashboard");
    } catch (err: any) {
      setError(err?.message || "Login failed. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#0a0a0a] px-4">
      <div className="max-w-md w-full z-10">
        <div className="bg-surface border border-border shadow-2xl rounded-3xl p-10">
          <div className="text-center mb-8">
            <h1 className="text-2xl font-bold text-white tracking-tight">Welcome Back</h1>
            <p className="text-slate-400 mt-2">Enter your details to access your terminal</p>
          </div>

          <form onSubmit={handleLogin} className="space-y-5">
            <div className="space-y-1.5">
              <label htmlFor="email" className="block text-sm font-semibold text-slate-300 ml-1">
                Email Address
              </label>
              <div className="relative group">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none text-slate-400 transition-colors">
                  <Mail size={18} />
                </div>
                <input
                  id="username"
                  type="text"
                  className="block w-full pl-11 pr-4 py-3 bg-white border border-slate-200 rounded-xl text-black placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-[#00C853]/20 focus:border-[#00C853] transition-all"
                  placeholder="name"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                  required
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="relative group">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none text-slate-400 transition-colors">
                  <Lock size={18} />
                </div>
                <input
                  id="password"
                  type="password"
                  className="block w-full pl-11 pr-4 py-3 bg-white border border-slate-200 rounded-xl text-black placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-[#00C853]/20 focus:border-[#00C853] transition-all"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  required
                />
              </div>
            </div>

            {/* <label className="flex items-center group cursor-pointer w-fit">
              <div className="relative flex items-center">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                  className="peer h-5 w-5 cursor-pointer appearance-none rounded border border-slate-300 checked:bg-black checked:border-black transition-all"
                />
                <svg className="absolute h-3.5 w-3.5 text-white opacity-0 peer-checked:opacity-100 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
              </div>
              <span className="ml-3 text-sm text-slate-300">Keep me signed in</span>
            </label> */}

            <button
              type="submit"
              disabled={loading}
              className="w-full relative flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl bg-[#00C853] text-white font-semibold hover:brightness-95 active:scale-[0.98] transition-all disabled:opacity-60 shadow-xl shadow-black/10"
            >
              {loading ? (
                <Loader2 className="animate-spin h-5 w-5" />
              ) : (
                <>
                  Sign in to Trade Bot
                  <ArrowRight size={18} />
                </>
              )}
            </button>

            {error && (
              <div className="p-3 rounded-lg bg-red-50 border border-red-100 text-red-600 text-sm font-medium">
                {error}
              </div>
            )}
          </form>
        </div>
      </div>
    </div>
  );
}
