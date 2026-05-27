import { getBaseUrlValue, request } from './client'

export interface AuthStatus {
  hasPasswordLogin: boolean
  hasUsers?: boolean
}

function authUrl(path: string): string {
  return `${getBaseUrlValue()}${path}`
}

async function parseJsonResponse<T>(res: Response, fallbackMessage: string): Promise<T> {
  const text = await res.text()
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(fallbackMessage)
  }
}

export async function fetchAuthStatus(): Promise<AuthStatus> {
  const res = await fetch(authUrl('/api/auth/status'))
  if (!res.ok) throw new Error('Failed to fetch auth status')
  return parseJsonResponse<AuthStatus>(res, 'Auth status endpoint returned a non-JSON response')
}

export async function loginWithPassword(username: string, password: string): Promise<string> {
  const res = await fetch(authUrl('/api/auth/login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  if (!res.ok) {
    const data: { error?: string } = await parseJsonResponse<{ error?: string }>(
      res,
      'Login endpoint returned a non-JSON response',
    ).catch(() => ({}))
    const err: any = new Error(data.error || 'Login failed')
    err.status = res.status
    throw err
  }
  const data = await parseJsonResponse<{ token: string }>(
    res,
    'Login endpoint returned a non-JSON response. Check that the server address points to Hermes Web UI.',
  )
  return data.token
}

export interface CurrentUser {
  id: number
  username: string
  role: UserRole
  status: UserStatus
  created_at: number
  updated_at: number
  last_login_at: number | null
  requiresCredentialChange?: boolean
}

export async function fetchCurrentUser(): Promise<CurrentUser> {
  const res = await request<{ user: CurrentUser }>('/api/auth/me')
  return res.user
}

export async function setupPassword(username: string, password: string): Promise<void> {
  return request('/api/auth/setup', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  return request('/api/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword, newPassword }),
  })
}

export async function changeUsername(currentPassword: string, newUsername: string): Promise<void> {
  return request('/api/auth/change-username', {
    method: 'POST',
    body: JSON.stringify({ currentPassword, newUsername }),
  })
}

export async function removePassword(): Promise<void> {
  return request('/api/auth/password', {
    method: 'DELETE',
  })
}

export type UserRole = 'super_admin' | 'admin'
export type UserStatus = 'active' | 'disabled'

export interface ManagedUser {
  id: number
  username: string
  role: UserRole
  status: UserStatus
  profiles: string[]
  default_profile: string | null
  created_at: number
  updated_at: number
  last_login_at: number | null
}

export interface ManagedUsersResponse {
  users: ManagedUser[]
  profiles: string[]
}

export async function fetchManagedUsers(): Promise<ManagedUsersResponse> {
  return request<ManagedUsersResponse>('/api/auth/users')
}

export async function createManagedUser(input: {
  username: string
  password: string
  role: UserRole
  status: UserStatus
  profiles: string[]
  defaultProfile?: string | null
}): Promise<ManagedUsersResponse> {
  const res = await request<{ users: ManagedUser[] }>('/api/auth/users', {
    method: 'POST',
    body: JSON.stringify(input),
  })
  const current = await fetchManagedUsers()
  return { ...current, users: res.users }
}

export async function updateManagedUser(id: number, input: {
  username?: string
  password?: string
  role?: UserRole
  status?: UserStatus
  profiles?: string[]
  defaultProfile?: string | null
}): Promise<ManagedUsersResponse> {
  const res = await request<{ users: ManagedUser[] }>(`/api/auth/users/${id}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  })
  const current = await fetchManagedUsers()
  return { ...current, users: res.users }
}

export async function deleteManagedUser(id: number): Promise<ManagedUsersResponse> {
  const res = await request<{ users: ManagedUser[] }>(`/api/auth/users/${id}`, {
    method: 'DELETE',
  })
  const current = await fetchManagedUsers()
  return { ...current, users: res.users }
}

export interface LockedIp {
  ip: string
  type: 'password' | 'token'
  failures: number
  lockedUntil: number
}

export async function fetchLockedIps(): Promise<LockedIp[]> {
  const res = await request<{ locks: LockedIp[] }>('/api/auth/locked-ips')
  return res.locks
}

export async function unlockSpecificIp(ip: string): Promise<void> {
  return request(`/api/auth/locked-ips?ip=${encodeURIComponent(ip)}`, {
    method: 'DELETE',
  })
}

export async function unlockAllIps(): Promise<number> {
  const res = await request<{ count: number }>('/api/auth/locked-ips', {
    method: 'DELETE',
  })
  return res.count
}
