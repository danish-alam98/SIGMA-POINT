
require("dotenv").config();
const { Pool } = require("pg");
const { Resend } = require("resend");
const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATA_FILE = path.join(__dirname, "data.json");

const pool = new Pool({
  
pool.query("SELECT NOW() AS server_time")
  .then(result => {
    console.log("PostgreSQL connected successfully!");
    console.log("Database time:", result.rows[0].server_time);
  })
  .catch(error => {
    console.error("PostgreSQL connection failed:", error.message);
  });

  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production"
    ? { rejectUnauthorized: false }
    : false
});

if (process.env.NODE_ENV === "production" &&
    (!process.env.SESSION_SECRET ||
     process.env.SESSION_SECRET.length < 32)) {
  throw new Error("Production mein SESSION_SECRET ko 32+ characters ka rakhein.");
}

const SESSION_SECRET = process.env.SESSION_SECRET ||
  "local-development-only-change-this-secret-123456789";

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));
app.set("trust proxy", 1);
app.use(session({
  name: "champion.sid",
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 8 * 60 * 60 * 1000
  }
}));

app.use(express.static(path.join(__dirname, "public")));

function makeId(prefix) {
  return prefix + "_" + Date.now().toString(36) +
    "_" + Math.random().toString(36).slice(2, 9);
}

function clean(value, max = 200) {
  return String(value ?? "").trim().slice(0, max);
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function loadDB() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({
      users: [],
      students: [],
      attendance: [],
      tests: [],
      submissions: [],
      results: [],
      fees: [],
      notices: [],
      otps: []
    }, null, 2));
  }

  const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));

  for (const key of [
    "users", "students", "attendance", "tests",
    "submissions", "results", "fees", "notices", "otps"
  ]) {
    if (!Array.isArray(data[key])) data[key] = [];
  }

  return data;
}

let db = loadDB();

function saveDB() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

function findUser(email) {
  return db.users.find(
    user => user.email.toLowerCase() === email.toLowerCase()
  );
}

function safeUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    className: user.className || ""
  };
}

function requireLogin(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Please log in first." });
  }

  const user = db.users.find(u => u.id === req.session.userId);

  if (!user) {
    return res.status(401).json({ error: "Account not found. Log in again." });
  }

  req.user = user;
  next();
}

function allowRoles(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: "You do not have permission." });
    }
    next();
  };
}


const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many attempts. Please try again after 1 minute."
  }
});


async function createInitialAccount(role, name, email, password) {
  if (!email || !password) return;

  const normalizedEmail = email.trim().toLowerCase();
  let user = findUser(normalizedEmail);

  if (password.length < 6) {
    throw new Error(role + " password must be at least 6 characters.");
  }

  if (!user) {
    user = {
      id: makeId("user"),
      name,
      email: normalizedEmail,
      passwordHash: await bcrypt.hash(password, 12),
      role,
      className: ""
    };
    db.users.push(user);
  } else {
    user.name = name;
    user.role = role;
    user.passwordHash = await bcrypt.hash(password, 12);
  }
}

async function initializeAccounts() {
  await createInitialAccount(
    "admin",
    process.env.ADMIN_NAME || "Portal Admin",
    process.env.ADMIN_EMAIL || "admin@example.com",
    process.env.ADMIN_PASSWORD || "ChangeAdmin123!"
  );

  await createInitialAccount(
    "teacher",
    process.env.TEACHER_NAME || "Class Teacher",
    process.env.TEACHER_EMAIL || "teacher@example.com",
    process.env.TEACHER_PASSWORD || "ChangeTeacher123!"
  );

  await createInitialAccount(
    "cashier",
    process.env.CASHIER_NAME || "Fee Cashier",
    process.env.CASHIER_EMAIL || "cashier@example.com",
    process.env.CASHIER_PASSWORD || "ChangeCashier123!"
  );

  saveDB();
}

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

async function sendOTP(email, code) {
  if (!process.env.RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY is missing.");
  }

  const from = process.env.RESEND_FROM;

  if (!from) {
    throw new Error("RESEND_FROM is missing.");
  }

  const { data, error } = await resend.emails.send({
    from,
    to: email,
    subject: "CHAMPION CLASSES login OTP",
    text:
      "Your CHAMPION CLASSES login OTP is " +
      code +
      ". It expires in 5 minutes. Do not share it."
  });

  if (error) {
    console.error("Resend email error:", error.message);
    throw new Error("Email provider could not send OTP.");
  }

  if (!data) {
    throw new Error("Email provider returned no confirmation.");
  }
}

// STEP 1: Email + password check, then send a 6-digit OTP.
// DIRECT LOGIN: Email + password, no OTP required.
app.post("/api/auth/login", loginLimiter, async (req, res) => {
  try {
    const email = clean(req.body.email, 160).toLowerCase();
    const password = String(req.body.password || "");
    const role = clean(req.body.role, 20);

    if (!validEmail(email) || !password) {
      return res.status(400).json({
        error: "Valid email aur password required hai."
      });
    }

    if (!["admin", "teacher", "student", "cashier"].includes(role)) {
      return res.status(400).json({
        error: "Valid login type select karo."
      });
    }

    const user = findUser(email);
    const passwordOK = user && user.role === role
      ? await bcrypt.compare(password, user.passwordHash)
      : false;

    if (!passwordOK) {
      return res.status(401).json({
        error: "Email, password ya login type galat hai."
      });
    }

    req.session.regenerate(error => {
      if (error) {
        return res.status(500).json({
          error: "Login session create nahi hua."
        });
      }

      req.session.userId = user.id;

      req.session.save(saveError => {
        if (saveError) {
          return res.status(500).json({
            error: "Login session save nahi hua."
          });
        }

        return res.json({ user: safeUser(user) });
      });
    });
  } catch (error) {
    console.error("Login error:", error);
    return res.status(500).json({
      error: "Login mein problem hui. Dobara try karo."
    });
  }
});
app.get("/api/me", requireLogin, (req, res) => {
  res.json({ user: safeUser(req.user) });
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("champion.sid");
    res.json({ ok: true });
  });
});

// DASHBOARD COUNTS
app.get("/api/dashboard", requireLogin, (req, res) => {
  const role = req.user.role;
  const studentId = req.user.id;

  res.json({
    stats: {
      students: role === "student" ? 1 : db.students.length,
      tests: db.tests.filter(t =>
        t.published &&
        (role !== "student" || t.className === req.user.className)
      ).length,
      results: db.results.filter(r =>
        role !== "student" || r.studentUserId === studentId
      ).length,
      attendanceRecords: db.attendance.filter(a =>
        role !== "student" || a.studentUserId === studentId
      ).length,
      feesDue: db.fees.filter(f =>
        f.status !== "Paid" &&
        (role !== "student" || f.studentUserId === studentId)
      ).length
    }
  });
});

// STUDENTS: Admin creates accounts.
app.get("/api/students", requireLogin, allowRoles("admin", "teacher", "cashier"), (req, res) => {
  res.json({ students: db.students });
});

app.post("/api/students", requireLogin, allowRoles("admin"), async (req, res) => {
  const name = clean(req.body.name);
  const email = clean(req.body.email, 160).toLowerCase();
  const className = clean(req.body.className, 60);
  const password = String(req.body.password || "");

  if (!name || !validEmail(email) || !className || password.length < 6) {
    return res.status(400).json({
      error: "Name, valid email, class aur password (minimum 6 characters) required."
    });
  }

  if (findUser(email)) {
    return res.status(409).json({ error: "Is email ka account already exists." });
  }

  const user = {
    id: makeId("user"),
    name,
    email,
    passwordHash: await bcrypt.hash(password, 12),
    role: "student",
    className
  };

  const student = {
    id: makeId("student"),
    userId: user.id,
    name,
    email,
    className,
    studentCode: "CC-" + Date.now().toString().slice(-7),
    createdAt: new Date().toISOString()
  };

  db.users.push(user);
  db.students.push(student);
  saveDB();

  res.status(201).json({ student });
});


app.put("/api/students/:id", requireLogin, allowRoles("admin"), async (req, res) => {
  const student = db.students.find(s => s.id === req.params.id);

  if (!student) {
    return res.status(404).json({ error: "Student nahi mila." });
  }

  const name = clean(req.body.name);
  const email = clean(req.body.email, 160).toLowerCase();
  const className = clean(req.body.className, 60);
  const studentCode = clean(req.body.studentCode, 40);

  if (!name || !validEmail(email) || !className || !studentCode) {
    return res.status(400).json({
      error: "Name, valid email, class aur Student ID required hain."
    });
  }

  const duplicateEmail = db.users.find(
    u => u.email === email && u.id !== student.userId
  );

  if (duplicateEmail) {
    return res.status(409).json({
      error: "Ye email kisi aur account mein use ho raha hai."
    });
  }

  const duplicateCode = db.students.find(
    s => s.studentCode === studentCode && s.id !== student.id
  );

  if (duplicateCode) {
    return res.status(409).json({
      error: "Ye Student ID pehle se kisi aur student ki hai."
    });
  }

  const user = db.users.find(u => u.id === student.userId);

  if (!user) {
    return res.status(404).json({
      error: "Student ka login account nahi mila."
    });
  }

  student.name = name;
  student.email = email;
  student.className = className;
  student.studentCode = studentCode;

  user.name = name;
  user.email = email;
  user.className = className;

  saveDB();

  res.json({ ok: true, student });
});


// ATTENDANCE: date-wise marking; one status per student/date.
app.get("/api/attendance", requireLogin, (req, res) => {
  const date = clean(req.query.date, 10);

  const rows = db.attendance.filter(a =>
    (!date || a.date === date) &&
    (req.user.role !== "student" || a.studentUserId === req.user.id)
  );

  res.json({ attendance: rows });
});

app.post("/api/attendance/bulk", requireLogin, allowRoles("admin", "teacher"), (req, res) => {
  const date = clean(req.body.date, 10);
  const records = Array.isArray(req.body.records) ? req.body.records : [];

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !records.length) {
    return res.status(400).json({ error: "Date aur attendance records required." });
  }

  for (const record of records) {
    const student = db.students.find(s => s.id === record.studentId);

    if (!student || !["Present", "Absent", "Late"].includes(record.status)) continue;

    const old = db.attendance.find(a =>
      a.studentId === student.id && a.date === date
    );

    const entry = {
      id: old ? old.id : makeId("att"),
      studentId: student.id,
      studentUserId: student.userId,
      name: student.name,
      className: student.className,
      date,
      status: record.status,
      markedBy: req.user.id
    };

    if (old) Object.assign(old, entry);
    else db.attendance.push(entry);
  }

  saveDB();
  res.json({ ok: true, message: "Attendance save ho gayi." });
});

app.get("/api/attendance/overview", requireLogin, allowRoles("admin", "teacher"), (req, res) => {
  const overview = db.students.map(student => {
    const records = db.attendance.filter(a => a.studentId === student.id);
    const present = records.filter(a => a.status === "Present").length;
    const absent = records.filter(a => a.status === "Absent").length;

    return {
      studentId: student.id,
      name: student.name,
      studentCode: student.studentCode,
      className: student.className,
      presentDays: present,
      absentDays: absent,
      totalDays: records.length,
      percentage: records.length ? Math.round(present / records.length * 100) : 0
    };
  });

  res.json({ overview });
});

// TESTS: teacher submits JSON and publishes to a particular class.
app.get("/api/tests", requireLogin, (req, res) => {
  const tests = db.tests.filter(t =>
    req.user.role !== "student" ||
    (t.published && t.className === req.user.className)
  ).map(t => ({
    ...t,
    questions: t.questions.map(({ answer, ...question }) => question)
  }));

  res.json({ tests });
});

app.post("/api/tests", requireLogin, allowRoles("admin", "teacher"), (req, res) => {
  const title = clean(req.body.title);
  const className = clean(req.body.className, 60);
  const questions = req.body.questions;

  if (!title || !className || !Array.isArray(questions) || !questions.length) {
    return res.status(400).json({ error: "Title, class aur JSON questions required." });
  }

  if (questions.length > 100) {
    return res.status(400).json({ error: "Ek test mein maximum 100 questions." });
  }

  for (const q of questions) {
    if (!clean(q.text, 500) ||
        !Array.isArray(q.options) ||
        q.options.length < 2 ||
        q.options.length > 10 ||
        !q.options.includes(q.answer)) {
      return res.status(400).json({
        error: "Har question mein text, 2-10 options aur options se matching answer required."
      });
    }
  }

  const test = {
    id: makeId("test"),
    title,
    className,
    questions: questions.map(q => ({
      id: makeId("q"),
      text: clean(q.text, 500),
      options: q.options.map(option => clean(option, 250)),
      answer: clean(q.answer, 250)
    })),
    published: false,
    createdBy: req.user.id,
    createdAt: new Date().toISOString(),
    publishedAt: null
  };

  db.tests.push(test);
  saveDB();

  res.status(201).json({
    test: {
      ...test,
      questions: test.questions.map(({ answer, ...q }) => q)
    }
  });
});


app.delete("/api/tests/:id", requireLogin, allowRoles("admin"), (req, res) => {
  const testIndex = db.tests.findIndex(
    t => t.id === req.params.id
  );

  if (testIndex === -1) {
    return res.status(404).json({
      error: "Test nahi mila."
    });
  }

  db.tests.splice(testIndex, 1);
  saveDB();

  res.json({
    message: "Test successfully delete ho gaya."
  });
});

app.post("/api/tests/:id/publish", requireLogin, allowRoles("admin", "teacher"), (req, res) => {
  const test = db.tests.find(t => t.id === req.params.id);

  if (!test) return res.status(404).json({ error: "Test nahi mila." });

  test.published = true;
  test.publishedAt = new Date().toISOString();
  saveDB();

  res.json({ ok: true, message: test.title + " " + test.className + " ke liye publish ho gaya." });
});

app.delete("/api/tests/:id", requireLogin, allowRoles("admin"), (req, res) => {
  const testId = req.params.id;

  const test = db.tests.find(t => t.id === testId);

  if (!test) {
    return res.status(404).json({
      error: "Test nahi mila."
    });
  }

  // Test ke saath uski submissions aur results bhi delete honge.
  db.submissions = db.submissions.filter(
    s => s.testId !== testId
  );

  if (Array.isArray(db.results)) {
    db.results = db.results.filter(
      r => r.testId !== testId
    );
  }

  db.tests = db.tests.filter(
    t => t.id !== testId
  );

  saveDB();

  res.json({
    ok: true,
    message: "Test successfully delete ho gaya."
  });
});


app.post("/api/tests/:id/submit", requireLogin, allowRoles("student"), (req, res) => {
  const test = db.tests.find(t =>
    t.id === req.params.id &&
    t.published &&
    t.className === req.user.className
  );

  if (!test) return res.status(404).json({ error: "Test available nahi hai." });

  if (db.submissions.some(s =>
    s.testId === test.id && s.studentUserId === req.user.id
  )) {
    return res.status(409).json({ error: "Aap ye test pehle submit kar chuke hain." });
  }

  const answers = req.body.answers && typeof req.body.answers === "object"
    ? req.body.answers : {};

  let score = 0;
  for (const question of test.questions) {
    if (answers[question.id] === question.answer) score++;
  }

  db.submissions.push({
    id: makeId("submission"),
    testId: test.id,
    testTitle: test.title,
    studentUserId: req.user.id,
    studentName: req.user.name,
    className: test.className,
    score,
    total: test.questions.length,
    submittedAt: new Date().toISOString(),
    published: false
  });

  saveDB();

  // Student gets only a message, never the marks.
  res.json({
    message: "Test submit ho gaya. Teacher result publish karega tabhi marks dikhenge."
  });
});

// RESULTS: student can only see published results.
app.get("/api/results", requireLogin, (req, res) => {
  const results = db.results.filter(r =>
    req.user.role !== "student" || r.studentUserId === req.user.id
  );

  res.json({ results });
});

app.get("/api/results/overview", requireLogin, allowRoles("admin", "teacher"), (req, res) => {
  const overview = db.submissions.map(s => ({
    id: s.id,
    testId: s.testId,
    testTitle: s.testTitle,
    studentName: s.studentName,
    studentUserId: s.studentUserId,
    className: s.className,
    score: s.score,
    total: s.total,
    submittedAt: s.submittedAt,
    published: s.published
  }));

  res.json({ overview });
});

app.post("/api/results/publish", requireLogin, allowRoles("admin", "teacher"), (req, res) => {
  const testId = clean(req.body.testId, 100);
  const className = clean(req.body.className, 60);

  let count = 0;

  for (const submission of db.submissions) {
    if (testId && submission.testId !== testId) continue;
    if (className && submission.className !== className) continue;

    submission.published = true;

    const result = {
      id: makeId("result"),
      submissionId: submission.id,
      testId: submission.testId,
      testTitle: submission.testTitle,
      studentUserId: submission.studentUserId,
      studentName: submission.studentName,
      className: submission.className,
      score: submission.score,
      total: submission.total,
      percentage: submission.total
        ? Math.round(submission.score / submission.total * 100) : 0,
      published: true,
      publishedAt: new Date().toISOString()
    };

    const oldIndex = db.results.findIndex(r => r.submissionId === submission.id);

    if (oldIndex >= 0) db.results[oldIndex] = result;
    else db.results.push(result);

    count++;
  }

  saveDB();
  res.json({ ok: true, message: count + " result(s) publish ho gaye." });
});

// CASHIER: payment entry and receipts.
app.get("/api/fees", requireLogin, allowRoles("admin", "cashier", "student"), (req, res) => {
  const fees = db.fees.filter(f =>
    req.user.role !== "student" || f.studentUserId === req.user.id
  );
  res.json({ fees });
});

app.post("/api/fees", requireLogin, allowRoles("admin", "cashier"), (req, res) => {
  const student = db.students.find(s => s.id === req.body.studentId);
  const amount = Number(req.body.amount);

  if (!student || !Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: "Student aur valid amount required." });
  }

  const fee = {
    id: makeId("fee"),
    receiptNo: "CC-R-" + Date.now(),
    studentId: student.id,
    studentUserId: student.userId,
    studentName: student.name,
    className: student.className,
    amount,
    month: clean(req.body.month, 60),
    status: "Paid",
    collectedBy: req.user.id,
    createdAt: new Date().toISOString()
  };

  db.fees.push(fee);
  saveDB();
  res.status(201).json({ fee });
});

// NOTICES
app.get("/api/notices", requireLogin, (req, res) => {
  res.json({
    notices: db.notices.filter(n =>
      n.className === "All" ||
      n.className === req.user.className ||
      ["admin", "teacher"].includes(req.user.role)
    )
  });
});

app.post("/api/notices", requireLogin, allowRoles("admin", "teacher"), (req, res) => {
  const title = clean(req.body.title);
  const body = clean(req.body.body, 2000);
  const className = clean(req.body.className, 60) || "All";

  if (!title || !body) {
    return res.status(400).json({ error: "Notice title aur message required." });
  }

  const notice = {
    id: makeId("notice"),
    title,
    body,
    className,
    createdAt: new Date().toISOString(),
    createdBy: req.user.id
  };

  db.notices.unshift(notice);
  saveDB();
  res.status(201).json({ notice });
});

// Keep this 404 handler AFTER all API routes.
app.use("/api", (req, res) => {
  res.status(404).json({ error: "API endpoint not found." });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

initializeAccounts()
  .then(() => {
    app.listen(PORT, () => {
      console.log("CHAMPION CLASSES running at http://localhost:" + PORT);
      console.log("Admin email: " + (process.env.ADMIN_EMAIL || "admin@example.com"));
      console.log("Teacher email: " + (process.env.TEACHER_EMAIL || "teacher@example.com"));
    });
  })
  .catch(error => {
    console.error("Startup error:", error);
    process.exit(1);
  });
