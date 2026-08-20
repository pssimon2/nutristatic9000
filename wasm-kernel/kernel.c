// WASM search kernel: the full engine — best-first walk plus the lazy filter
// machinery (on-demand subset construction per conjunct NFA, lazy product of
// conjuncts) — so anagram and intersection queries run in the kernel. Driven
// by src/wasm-session.ts; the JS engine is the reference implementation and
// the fallback.
//
// Build (npm run build-wasm):
//   clang --target=wasm32-unknown-unknown -O3 -nostdlib \
//     -Wl,--no-entry -Wl,--export-dynamic -Wl,--allow-undefined \
//     -Wl,--initial-memory=17039360 -Wl,--max-memory=3221225472 \
//     -o kernel.wasm kernel.c
//
// ===== ABI (the contract src/wasm-session.ts drives) =====
// Call order: walloc (index bytes, alphabet, io mailbox) -> setup ->
// heap_mark once; then per query: heap_reset(mark) -> begin_query ->
// add_conjunct xN -> seed -> run (repeatedly, with a step budget).
//
// Memory ownership: THE HOST GROWS MEMORY, walloc never does — it is an
// unchecked bump allocator, and an allocation past the last grow does not
// fail here, it traps on the first write. wasm-session.ts grows once at
// create() to cover the index plus every reserved capacity, and per-query
// allocations must stay inside that reservation.
//
// heap_mark/heap_reset: everything walloc'd before the mark (index,
// alphabet, io, parse cache) is permanent; everything after it is per-query
// and reclaimed by heap_reset. Setup-time tables must therefore be
// allocated before the host takes its mark.
//
// io mailbox layout (fixed offsets, mirrored in wasm-session.ts):
//   +0  u32 steps taken this run()   +4  u32 result text length
//   +8  f64 result score             +16 result text bytes (<= 512)
//
// run(budget) returns: 0 budget exhausted, 1 result in the mailbox,
// 2 search space done, 3 capacity overflow (host falls back to JS).

typedef unsigned char u8;
typedef unsigned int u32;
typedef int i32;
typedef double f64;

#define NSYM 37
#define NO_NODE 0xFFFFFFFFu
#define UNCOMPUTED -2
#define DEAD -1
// An intern table (subset-DFA states, member pool, product states) is full.
#define NO_ID 0xFFFFFFFFu
// Transition-function result: some capacity overflowed; run() returns 3 and
// the host replays the query on the JS engine.
#define CAP_OVERFLOW -3
#define MAX_CONJ 32

extern u8 __heap_base;
static u32 heap_top = 0;

__attribute__((export_name("walloc"))) u32 walloc(u32 n) {
  if (heap_top == 0) heap_top = (u32)&__heap_base;
  u32 p = (heap_top + 15) & ~15u;
  heap_top = p + n;
  return p;
}

// Bump-allocator checkpointing: the host marks the heap after the one-time
// setup and resets to that mark before each query, so per-query tables are
// reused instead of leaking (walloc never frees).
__attribute__((export_name("heap_mark"))) u32 heap_mark(void) {
  if (heap_top == 0) heap_top = (u32)&__heap_base;
  return heap_top;
}

__attribute__((export_name("heap_reset"))) void heap_reset(u32 mark) {
  heap_top = mark;
}

// ---- index + alphabet ----
static u8 *idx;
static u32 idx_len, root;
static i32 sym_of[256];
static u8 alphabet[NSYM];
static f64 total, restart;
static u8 *io;

// ---- lazy sub-filter (subset construction over one NFA) ----
typedef struct {
  // NFA (CSR arcs)
  u32 n_nfa, start;
  u32 *arc_start; // n_nfa+1
  u8 *arc_label;  // 0 = epsilon
  u32 *arc_to;
  u8 *nfa_final; // bitmap-ish bytes
  // lazy DFA
  u32 n_dfa, dfa_cap;
  i32 *trans; // dfa_cap*NSYM
  u8 *acc;
  u32 *set_start; // dfa_cap+1 (CSR into set_pool)
  u32 *set_pool;
  u32 pool_len, pool_cap;
  // subset intern
  u32 *slot; // -> dfa_id+1
  u32 slot_mask;
  // scratch bitmap for closures
  u32 *mark; // n_nfa bits
} Sub;

static Sub subs[MAX_CONJ];
static u32 n_subs = 0;

static u32 hash_ints(u32 *a, u32 n) {
  u32 h = 0x9e3779b9u;
  for (u32 i = 0; i < n; ++i) {
    h = (h ^ a[i]) * 0x85ebca6bu;
    h ^= h >> 13;
  }
  return h;
}

// Collect epsilon-closure of marked seeds (mark bitmap pre-set) into sorted
// member list appended to the sub's pool. Returns member count.
// Returns the member count written at pool_len, or NO_ID if the pool
// cannot hold this set.
static u32 close_and_collect(Sub *s, u32 *stack, u32 stack_n) {
  while (stack_n > 0) {
    u32 q = stack[--stack_n];
    for (u32 a = s->arc_start[q]; a < s->arc_start[q + 1]; ++a) {
      if (s->arc_label[a] == 0) {
        u32 t = s->arc_to[a];
        if (!(s->mark[t >> 5] & (1u << (t & 31)))) {
          s->mark[t >> 5] |= 1u << (t & 31);
          stack[stack_n++] = t;
        }
      }
    }
  }
  // How many members before writing any: the pool is a fixed reservation, and
  // filling it past the end would scribble over the tables that follow. The
  // capacity is checked here rather than in sub_intern, which hashes and
  // compares the members before it gets to its own check — reading members
  // that were never written could match some other set and return the wrong
  // state id instead of reporting overflow.
  u32 count = 0;
  const u32 words = (s->n_nfa + 31) / 32;
  for (u32 w = 0; w < words; ++w) count += __builtin_popcount(s->mark[w]);
  if (s->pool_len + count > s->pool_cap) return NO_ID;

  // scan bitmap ascending -> sorted members
  count = 0;
  for (u32 w = 0; w < words; ++w) {
    u32 bits = s->mark[w];
    while (bits) {
      u32 b = __builtin_ctz(bits);
      bits &= bits - 1;
      s->set_pool[s->pool_len + count] = w * 32 + b;
      ++count;
    }
  }
  return count;
}

static u32 scratch_stack[65536];

// Intern the member list sitting at pool_len..pool_len+count; returns dfa id
// or 0xFFFFFFFF on capacity overflow.
static u32 sub_intern(Sub *s, u32 count) {
  u32 *members = s->set_pool + s->pool_len;
  u32 h = hash_ints(members, count) & s->slot_mask;
  for (;;) {
    u32 v = s->slot[h];
    if (v == 0) break;
    u32 id = v - 1;
    u32 st = s->set_start[id], en = s->set_start[id + 1];
    if (en - st == count) {
      u32 same = 1;
      for (u32 i = 0; i < count; ++i) {
        if (s->set_pool[st + i] != members[i]) {
          same = 0;
          break;
        }
      }
      if (same) return id;
    }
    h = (h + 1) & s->slot_mask;
  }
  if (s->n_dfa >= s->dfa_cap) return NO_ID;
  if (s->pool_len + count > s->pool_cap) return NO_ID;
  u32 id = s->n_dfa++;
  s->slot[h] = id + 1;
  s->pool_len += count;
  s->set_start[id + 1] = s->pool_len;
  u8 acc = 0;
  for (u32 i = 0; i < count; ++i) {
    if (s->nfa_final[members[i]]) {
      acc = 1;
      break;
    }
  }
  s->acc[id] = acc;
  for (u32 k = 0; k < NSYM; ++k) s->trans[id * NSYM + k] = UNCOMPUTED;
  return id;
}

static i32 sub_transition(Sub *s, u32 state, u32 sy) {
  i32 t = s->trans[state * NSYM + sy];
  if (t != UNCOMPUTED) return t;
  u8 label = alphabet[sy];
  // seed marks with move targets
  for (u32 w = 0; w < (s->n_nfa + 31) / 32; ++w) s->mark[w] = 0;
  u32 stack_n = 0;
  for (u32 i = s->set_start[state]; i < s->set_start[state + 1]; ++i) {
    u32 q = s->set_pool[i];
    for (u32 a = s->arc_start[q]; a < s->arc_start[q + 1]; ++a) {
      if (s->arc_label[a] == label) {
        u32 to = s->arc_to[a];
        if (!(s->mark[to >> 5] & (1u << (to & 31)))) {
          s->mark[to >> 5] |= 1u << (to & 31);
          scratch_stack[stack_n++] = to;
        }
      }
    }
  }
  i32 result;
  if (stack_n == 0) {
    result = DEAD;
  } else {
    u32 count = close_and_collect(s, scratch_stack, stack_n);
    u32 id = count == NO_ID ? NO_ID : sub_intern(s, count);
    result = id == NO_ID ? CAP_OVERFLOW : (i32)id;
  }
  if (result != CAP_OVERFLOW) s->trans[state * NSYM + sy] = result;
  return result;
}

// ---- lazy product filter ----
static u32 width;      // = n_subs
static u32 p_cap, p_n; // product states
static i32 *p_trans;   // p_cap*NSYM
static u8 *p_acc;
static u32 *p_pool; // p_cap*width tuples
static u32 *p_slot;
static u32 p_slot_mask;

static u32 prod_intern(u32 *tuple) {
  u32 h = hash_ints(tuple, width) & p_slot_mask;
  for (;;) {
    u32 v = p_slot[h];
    if (v == 0) break;
    u32 id = v - 1;
    u32 same = 1;
    for (u32 i = 0; i < width; ++i) {
      if (p_pool[id * width + i] != tuple[i]) {
        same = 0;
        break;
      }
    }
    if (same) return id;
    h = (h + 1) & p_slot_mask;
  }
  if (p_n >= p_cap) return NO_ID;
  u32 id = p_n++;
  p_slot[h] = id + 1;
  u8 acc = 1;
  for (u32 i = 0; i < width; ++i) {
    p_pool[id * width + i] = tuple[i];
    if (!subs[i].acc[tuple[i]]) acc = 0;
  }
  p_acc[id] = acc;
  for (u32 k = 0; k < NSYM; ++k) p_trans[id * NSYM + k] = UNCOMPUTED;
  return id;
}

static u32 tuple_scratch[MAX_CONJ];

// returns product state, DEAD, or CAP_OVERFLOW
static i32 prod_transition(u32 state, u8 ch) {
  i32 sy = ch < 128 ? sym_of[ch] : -1;
  if (sy < 0) return DEAD;
  i32 t = p_trans[state * NSYM + (u32)sy];
  if (t != UNCOMPUTED) return t;
  for (u32 i = 0; i < width; ++i) {
    i32 st = sub_transition(&subs[i], p_pool[state * width + i], (u32)sy);
    if (st == CAP_OVERFLOW) return CAP_OVERFLOW;
    if (st == DEAD) {
      p_trans[state * NSYM + (u32)sy] = DEAD;
      return DEAD;
    }
    tuple_scratch[i] = (u32)st;
  }
  u32 id = prod_intern(tuple_scratch);
  if (id == NO_ID) return CAP_OVERFLOW;
  p_trans[state * NSYM + (u32)sy] = (i32)id;
  return (i32)id;
}

// ---- frontier / crumbs / parse (as kernel v1) ----
static i32 *f_crumb, *f_state;
static u8 *f_ch;
static f64 *f_scale, *f_count, *f_pri;
static u32 *f_next;
static u32 f_size, f_cap;
static i32 *c_parent;
static u8 *c_ch;
static u32 c_len, c_cap;

static void heap_set(u32 i, u32 j) {
  f_crumb[i] = f_crumb[j];
  f_state[i] = f_state[j];
  f_ch[i] = f_ch[j];
  f_scale[i] = f_scale[j];
  f_count[i] = f_count[j];
  f_pri[i] = f_pri[j];
  f_next[i] = f_next[j];
}

static int heap_push(i32 crumb, i32 state, u8 ch, f64 scale, f64 count,
                     u32 next) {
  if (f_size >= f_cap) return 0;
  u32 i = f_size++;
  f64 pri = count * scale;
  while (i > 0) {
    u32 parent = (i - 1) >> 2;
    if (f_pri[parent] >= pri) break;
    heap_set(i, parent);
    i = parent;
  }
  f_crumb[i] = crumb;
  f_state[i] = state;
  f_ch[i] = ch;
  f_scale[i] = scale;
  f_count[i] = count;
  f_pri[i] = pri;
  f_next[i] = next;
  return 1;
}

static i32 topCrumb, topState;
static u8 topCh;
static f64 topScale, topCount;
static u32 topNext;

static void heap_pop(void) {
  topCrumb = f_crumb[0];
  topState = f_state[0];
  topCh = f_ch[0];
  topScale = f_scale[0];
  topCount = f_count[0];
  topNext = f_next[0];
  u32 last = --f_size;
  if (last == 0) return;
  f64 pri = f_pri[last];
  u32 i = 0;
  for (;;) {
    u32 c0 = 4 * i + 1;
    if (c0 >= last) break;
    u32 m = c0;
    f64 mp = f_pri[c0];
    u32 cEnd = c0 + 4 < last ? c0 + 4 : last;
    for (u32 c = c0 + 1; c < cEnd; ++c) {
      if (f_pri[c] > mp) {
        m = c;
        mp = f_pri[c];
      }
    }
    if (mp <= pri) break;
    heap_set(i, m);
    i = m;
  }
  heap_set(i, last);
}

#define MAXCH 300
static u8 t_ch[MAXCH];
static f64 t_count[MAXCH];
static u32 t_next[MAXCH];
static u32 t_n;

// ---- parse cache ----
// Trie nodes are re-parsed every time the search reaches them via a different
// filter state, so memoize the parsed children by node offset. The parse is
// query-independent (the trie is immutable), so this cache is allocated once
// and persists across queries on the loaded index. Cache on the second visit
// (mark-then-insert) to avoid storing nodes seen only once. The `count` guard
// mirrors the JS reader: a node's edge count is intrinsic, so it matches on
// reuse, but a mismatch safely re-parses.
#define PC_SLOTS (1u << 21)
#define PC_MAX_ENTRIES (1u << 20)
#define PC_POOL 4000000u
static u32 *pc_key, *pc_val; // slots: key 0 = empty; val 0 = seen, else id+1
static f64 *pc_cnt;          // per-entry count guard
static u32 *pc_start, *pc_num;
static u8 *pc_pch;
static f64 *pc_pcnt;
static u32 *pc_pnext;
static u32 pc_nent, pc_pool_len, pc_used;

static u32 pc_find(u32 off) {
  u32 h = off * 2654435761u;
  h ^= h >> 15;
  u32 i = h & (PC_SLOTS - 1);
  while (pc_key[i] != 0 && pc_key[i] != off) i = (i + 1) & (PC_SLOTS - 1);
  return i;
}

static void pc_clear(void) {
  for (u32 i = 0; i < PC_SLOTS; ++i) pc_key[i] = 0;
  pc_nent = 0;
  pc_pool_len = 0;
  pc_used = 0;
}

static void pc_mark_seen(u32 key) {
  if (pc_used >= PC_SLOTS - (PC_SLOTS >> 2)) pc_clear(); // keep load factor < 3/4
  u32 slot = pc_find(key);
  if (pc_key[slot] == 0) {
    pc_key[slot] = key;
    pc_val[slot] = 0;
    ++pc_used;
  }
}

static void parse_children_body(u32 n, u32 num);

static void parse_children(u32 n, f64 count) {
  t_n = 0;
  if (n == NO_NODE) return;

  const u32 key = n;
  u32 slot = pc_find(key);
  if (pc_key[slot] != 0 && pc_val[slot] != 0) {
    u32 e = pc_val[slot] - 1;
    if (pc_cnt[e] == count) { // cache hit
      u32 s = pc_start[e], k = pc_num[e];
      for (u32 i = 0; i < k; ++i) {
        t_ch[i] = pc_pch[s + i];
        t_count[i] = pc_pcnt[s + i];
        t_next[i] = pc_pnext[s + i];
      }
      t_n = k;
      return;
    }
  }

  u32 num = idx[--n];
  if (num >= 0x20 && num < 0x80) {
    t_ch[0] = (u8)num;
    t_count[0] = count;
    t_next[0] = n;
    t_n = 1;
  } else {
    parse_children_body(n, num);
  }

  // Cache management: first visit marks the node; second caches it.
  if (pc_key[slot] == 0) {
    pc_mark_seen(key);
  } else if (pc_val[slot] == 0) {
    if (pc_nent >= PC_MAX_ENTRIES || pc_pool_len + t_n > PC_POOL) {
      pc_clear();
      pc_mark_seen(key);
    } else {
      u32 e = pc_nent++;
      pc_cnt[e] = count;
      pc_start[e] = pc_pool_len;
      pc_num[e] = t_n;
      for (u32 i = 0; i < t_n; ++i) {
        pc_pch[pc_pool_len + i] = t_ch[i];
        pc_pcnt[pc_pool_len + i] = t_count[i];
        pc_pnext[pc_pool_len + i] = t_next[i];
      }
      pc_pool_len += t_n;
      pc_val[slot] = e + 1;
    }
  }
}

// Parse a multi-child node body (n points just past the num byte) into t_*.
static void parse_children_body(u32 n, u32 num) {
  u32 count_size = num < 0xC0 ? 1 : num < 0xE0 ? 2 : 8;
  u32 offset_size = num < 0x20 ? 0 : num < 0xA0 ? 1 : num < 0xE0 ? 2 : 8;
  num &= 0x1F;
  if (num == 0) num = idx[--n];
  u32 size = count_size + offset_size + 1;
  u32 start = n - num * size;
  for (u32 p = start; p < n; p += size) {
    u8 ch = idx[p];
    f64 ccount;
    if (count_size == 1) {
      ccount = idx[p + 1];
    } else if (count_size == 2) {
      ccount = (f64)(idx[p + 1] | ((u32)idx[p + 2] << 8));
    } else {
      ccount = 0;
      f64 mul = 1;
      for (u32 j = 0; j < 8; ++j) {
        ccount += (f64)idx[p + 1 + j] * mul;
        mul *= 256.0;
      }
    }
    u32 next;
    if (offset_size == 0) {
      next = NO_NODE;
    } else if (offset_size == 1) {
      u32 off = idx[p + 1 + count_size];
      next = off == 0xFF ? NO_NODE : start - off;
    } else if (offset_size == 2) {
      u32 off = idx[p + count_size + 1] | ((u32)idx[p + count_size + 2] << 8);
      next = off == 0xFFFF ? NO_NODE : start - off;
    } else {
      int ones = 1;
      f64 mul = 1;
      f64 offf = 0;
      for (u32 j = 0; j < 8; ++j) {
        u8 b = idx[p + 1 + count_size + j];
        if (b != 0xFF) ones = 0;
        offf += (f64)b * mul;
        mul *= 256.0;
      }
      next = ones ? NO_NODE : start - (u32)offf;
    }
    t_ch[t_n] = ch;
    t_count[t_n] = ccount;
    t_next[t_n] = next;
    ++t_n;
  }
}

// ---- setup API ----
__attribute__((export_name("setup"))) void setup(u32 idx_ptr, u32 idx_len_,
                                                 u32 alpha_ptr, f64 restart_,
                                                 u32 f_cap_, u32 c_cap_,
                                                 u32 io_ptr) {
  idx = (u8 *)idx_ptr;
  idx_len = idx_len_;
  root = idx_len;
  restart = restart_;
  io = (u8 *)io_ptr;
  u8 *alpha = (u8 *)alpha_ptr;
  for (int i = 0; i < 256; ++i) sym_of[i] = -1;
  for (int i = 0; i < NSYM; ++i) {
    alphabet[i] = alpha[i];
    sym_of[alpha[i]] = i;
  }
  f_cap = f_cap_;
  c_cap = c_cap_;
  f_crumb = (i32 *)walloc(f_cap * 4);
  f_state = (i32 *)walloc(f_cap * 4);
  f_ch = (u8 *)walloc(f_cap);
  f_scale = (f64 *)walloc(f_cap * 8);
  f_count = (f64 *)walloc(f_cap * 8);
  f_pri = (f64 *)walloc(f_cap * 8);
  f_next = (u32 *)walloc(f_cap * 4);
  c_parent = (i32 *)walloc(c_cap * 4);
  c_ch = (u8 *)walloc(c_cap);
  // Parse cache (persists across queries: allocated below the query heap
  // mark, so heap_reset never touches it). walloc'd memory starts zeroed.
  pc_key = (u32 *)walloc(PC_SLOTS * 4);
  pc_val = (u32 *)walloc(PC_SLOTS * 4);
  pc_cnt = (f64 *)walloc(PC_MAX_ENTRIES * 8);
  pc_start = (u32 *)walloc(PC_MAX_ENTRIES * 4);
  pc_num = (u32 *)walloc(PC_MAX_ENTRIES * 4);
  pc_pch = (u8 *)walloc(PC_POOL);
  pc_pcnt = (f64 *)walloc(PC_POOL * 8);
  pc_pnext = (u32 *)walloc(PC_POOL * 4);
  pc_nent = 0;
  pc_pool_len = 0;
  pc_used = 0;
}

// Reset per-query filter state; conjuncts get added afterwards.
__attribute__((export_name("begin_query"))) void begin_query(u32 p_cap_) {
  n_subs = 0;
  p_cap = p_cap_;
  p_n = 0;
}

// Add one conjunct NFA (already trimmed on the JS side). dfa_cap bounds the
// lazily-built subset states for this conjunct.
__attribute__((export_name("add_conjunct"))) u32 add_conjunct(
    u32 n_states, u32 start, u32 arc_start_ptr, u32 arc_label_ptr,
    u32 arc_to_ptr, u32 final_ptr, u32 dfa_cap, u32 pool_cap) {
  if (n_subs >= MAX_CONJ) return 0;
  Sub *s = &subs[n_subs++];
  s->n_nfa = n_states;
  s->start = start;
  s->arc_start = (u32 *)arc_start_ptr;
  s->arc_label = (u8 *)arc_label_ptr;
  s->arc_to = (u32 *)arc_to_ptr;
  s->nfa_final = (u8 *)final_ptr;
  s->n_dfa = 0;
  s->dfa_cap = dfa_cap;
  s->trans = (i32 *)walloc(dfa_cap * NSYM * 4);
  s->acc = (u8 *)walloc(dfa_cap);
  s->set_start = (u32 *)walloc((dfa_cap + 1) * 4);
  s->set_start[0] = 0;
  s->pool_cap = pool_cap;
  s->set_pool = (u32 *)walloc(pool_cap * 4);
  s->pool_len = 0;
  u32 slots = 1;
  while (slots < dfa_cap * 2) slots <<= 1;
  s->slot = (u32 *)walloc(slots * 4);
  for (u32 i = 0; i < slots; ++i) s->slot[i] = 0;
  s->slot_mask = slots - 1;
  s->mark = (u32 *)walloc(((n_states + 31) / 32) * 4);
  return 1;
}

// Finish filter construction: build each sub's start state, intern the
// start tuple, allocate product tables, seed the frontier.
__attribute__((export_name("seed"))) i32 seed(f64 total_) {
  total = total_;
  width = n_subs;
  p_trans = (i32 *)walloc(p_cap * NSYM * 4);
  p_acc = (u8 *)walloc(p_cap);
  p_pool = (u32 *)walloc(p_cap * width * 4);
  u32 slots = 1;
  while (slots < p_cap * 2) slots <<= 1;
  p_slot = (u32 *)walloc(slots * 4);
  for (u32 i = 0; i < slots; ++i) p_slot[i] = 0;
  p_slot_mask = slots - 1;
  p_n = 0;

  for (u32 i = 0; i < width; ++i) {
    Sub *s = &subs[i];
    for (u32 w = 0; w < (s->n_nfa + 31) / 32; ++w) s->mark[w] = 0;
    s->mark[s->start >> 5] |= 1u << (s->start & 31);
    scratch_stack[0] = s->start;
    u32 count = close_and_collect(s, scratch_stack, 1);
    u32 id = count == NO_ID ? NO_ID : sub_intern(s, count);
    if (id == NO_ID) return -1;
    tuple_scratch[i] = id;
  }
  u32 startProd = prod_intern(tuple_scratch);
  if (startProd == NO_ID) return -1;
  f_size = 0;
  c_len = 0;
  heap_push(-1, (i32)startProd, 0, 1.0, total, root);
  return 0;
}

// run(budget): 0 budget, 1 result, 2 done, 3 capacity overflow
__attribute__((export_name("run"))) i32 run(u32 budget) {
  u32 steps = 0;
  u32 *io_steps = (u32 *)io;
  u32 *io_len = (u32 *)(io + 4);
  f64 *io_score = (f64 *)(io + 8);
  u8 *io_text = io + 16;
  while (steps < budget) {
    if (f_size == 0) {
      *io_steps = steps;
      return 2;
    }
    heap_pop();
    ++steps;
    parse_children(topNext, topCount);
    u32 newCrumb = c_len;
    for (u32 i = 0; i < t_n; ++i) {
      i32 s2 = prod_transition((u32)topState, t_ch[i]);
      if (s2 == CAP_OVERFLOW) {
        *io_steps = steps;
        return 3;
      }
      if (s2 >= 0) {
        if (c_len == newCrumb) {
          if (c_len >= c_cap) {
            *io_steps = steps;
            return 3;
          }
          c_parent[c_len] = topCrumb;
          c_ch[c_len] = topCh;
          ++c_len;
        }
        if (!heap_push((i32)newCrumb, s2, t_ch[i], topScale, t_count[i],
                       t_next[i])) {
          *io_steps = steps;
          return 3;
        }
      }
    }
    /* Scheduled BEFORE the accepting check, which returns as soon as it has a
       result. A node that is both accepting and a word boundary used to
       return here and never continue the phrase: `e{2}a?` reported "ee" and
       never looked at "ee a". The JS engine had the same bug in the same
       order. */
    if (restart > 0.0 && topCh == 0x20 && topNext != root) {
      f64 scale = topScale * topCount / total * restart;
      if (scale > 0) {
        if (!heap_push(topCrumb, topState, 0x20, scale, total, root)) {
          *io_steps = steps;
          return 3;
        }
      }
    }
    if (p_acc[topState] && topCrumb != -1) {
      u32 len = 0;
      for (i32 i = topCrumb; i >= 0; i = c_parent[i]) ++len;
      if (len > 500) len = 500;
      io_text[len - 1] = topCh;
      u32 pos = len - 1;
      for (i32 i = topCrumb; i >= 0 && pos > 0; i = c_parent[i]) {
        io_text[--pos] = c_ch[i];
      }
      *io_len = len;
      *io_score = topScale * topCount;
      *io_steps = steps;
      return 1;
    }
  }
  *io_steps = steps;
  return 0;
}
