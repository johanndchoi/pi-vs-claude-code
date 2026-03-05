/**
 * Customer Support Agent — AI-powered support workflow
 *
 * Provides tools for:
 *   - Analyzing customer messages (intent, sentiment, urgency)
 *   - Looking up order/tracking details
 *   - Troubleshooting common issues
 *   - Drafting professional responses
 *
 * Includes a mock data layer for orders, tracking, and customer records.
 * Replace the mock functions with real API calls for production use.
 *
 * Commands:
 *   /cs-history <customer_id>  — Show recent tickets for a customer
 *   /cs-stats                  — Show support queue stats
 *
 * Usage: pi -e extensions/customer-support.ts
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";

// ── Mock Data Layer ──────────────────────────────
// Replace these with real API integrations

interface Order {
	orderId: string;
	customerId: string;
	customerName: string;
	customerEmail: string;
	items: { name: string; qty: number; price: number }[];
	total: number;
	status: "processing" | "shipped" | "delivered" | "returned" | "cancelled";
	createdAt: string;
	tracking?: TrackingInfo;
}

interface TrackingInfo {
	carrier: string;
	trackingNumber: string;
	status: string;
	estimatedDelivery: string;
	events: { date: string; location: string; description: string }[];
}

interface CustomerRecord {
	customerId: string;
	name: string;
	email: string;
	phone: string;
	tier: "standard" | "premium" | "vip";
	accountCreated: string;
	totalOrders: number;
	openTickets: number;
	notes: string[];
}

interface Ticket {
	ticketId: string;
	customerId: string;
	subject: string;
	status: "open" | "pending" | "resolved" | "closed";
	priority: "low" | "medium" | "high" | "critical";
	category: string;
	createdAt: string;
	updatedAt: string;
	messages: { role: "customer" | "agent"; text: string; timestamp: string }[];
}

// Mock database
const MOCK_ORDERS: Record<string, Order> = {
	"ORD-10042": {
		orderId: "ORD-10042",
		customerId: "CUST-301",
		customerName: "Sarah Chen",
		customerEmail: "sarah.chen@email.com",
		items: [
			{ name: "Wireless Noise-Cancelling Headphones", qty: 1, price: 249.99 },
			{ name: "USB-C Charging Cable (6ft)", qty: 2, price: 14.99 },
		],
		total: 279.97,
		status: "shipped",
		createdAt: "2026-02-18T10:30:00Z",
		tracking: {
			carrier: "FedEx",
			trackingNumber: "FX-789456123",
			status: "In Transit",
			estimatedDelivery: "2026-02-26",
			events: [
				{ date: "2026-02-22T14:00:00Z", location: "Memphis, TN", description: "Departed FedEx hub" },
				{ date: "2026-02-21T09:15:00Z", location: "Memphis, TN", description: "Arrived at FedEx hub" },
				{ date: "2026-02-20T16:30:00Z", location: "Shenzhen, CN", description: "Shipment picked up" },
			],
		},
	},
	"ORD-10039": {
		orderId: "ORD-10039",
		customerId: "CUST-301",
		customerName: "Sarah Chen",
		customerEmail: "sarah.chen@email.com",
		items: [{ name: "Ergonomic Keyboard", qty: 1, price: 179.99 }],
		total: 179.99,
		status: "delivered",
		createdAt: "2026-02-10T08:00:00Z",
		tracking: {
			carrier: "UPS",
			trackingNumber: "1Z999AA10123456784",
			status: "Delivered",
			estimatedDelivery: "2026-02-14",
			events: [
				{ date: "2026-02-14T11:23:00Z", location: "San Francisco, CA", description: "Delivered - Left at front door" },
				{ date: "2026-02-13T18:00:00Z", location: "Oakland, CA", description: "Out for delivery" },
			],
		},
	},
	"ORD-10045": {
		orderId: "ORD-10045",
		customerId: "CUST-455",
		customerName: "James Rodriguez",
		customerEmail: "j.rodriguez@email.com",
		items: [
			{ name: "4K Monitor 27\"", qty: 1, price: 449.99 },
			{ name: "Monitor Arm Mount", qty: 1, price: 39.99 },
		],
		total: 489.98,
		status: "processing",
		createdAt: "2026-02-23T15:45:00Z",
	},
	"ORD-10031": {
		orderId: "ORD-10031",
		customerId: "CUST-128",
		customerName: "Emily Watson",
		customerEmail: "e.watson@email.com",
		items: [{ name: "Smart Home Hub Pro", qty: 1, price: 129.99 }],
		total: 129.99,
		status: "returned",
		createdAt: "2026-02-05T12:00:00Z",
	},
};

const MOCK_CUSTOMERS: Record<string, CustomerRecord> = {
	"CUST-301": {
		customerId: "CUST-301",
		name: "Sarah Chen",
		email: "sarah.chen@email.com",
		phone: "+1-415-555-0142",
		tier: "premium",
		accountCreated: "2024-06-15",
		totalOrders: 12,
		openTickets: 1,
		notes: ["Prefers email communication", "Loyal customer since 2024"],
	},
	"CUST-455": {
		customerId: "CUST-455",
		name: "James Rodriguez",
		email: "j.rodriguez@email.com",
		phone: "+1-212-555-0198",
		tier: "standard",
		accountCreated: "2025-11-02",
		totalOrders: 3,
		openTickets: 0,
		notes: [],
	},
	"CUST-128": {
		customerId: "CUST-128",
		name: "Emily Watson",
		email: "e.watson@email.com",
		phone: "+1-310-555-0267",
		tier: "vip",
		accountCreated: "2023-01-20",
		totalOrders: 47,
		openTickets: 2,
		notes: ["VIP — escalate issues immediately", "Has had 3 returns in last 6 months"],
	},
};

const MOCK_TICKETS: Ticket[] = [
	{
		ticketId: "TKT-8801",
		customerId: "CUST-301",
		subject: "Where is my headphone order?",
		status: "open",
		priority: "medium",
		category: "shipping",
		createdAt: "2026-02-24T09:00:00Z",
		updatedAt: "2026-02-24T09:00:00Z",
		messages: [
			{
				role: "customer",
				text: "Hi, I ordered wireless headphones last week (order ORD-10042) and the tracking hasn't updated in 2 days. Can you help?",
				timestamp: "2026-02-24T09:00:00Z",
			},
		],
	},
	{
		ticketId: "TKT-8795",
		customerId: "CUST-128",
		subject: "Smart Home Hub not connecting to WiFi",
		status: "pending",
		priority: "high",
		category: "technical",
		createdAt: "2026-02-22T14:30:00Z",
		updatedAt: "2026-02-23T10:00:00Z",
		messages: [
			{
				role: "customer",
				text: "My Smart Home Hub Pro won't connect to my WiFi network. I've tried restarting it multiple times. The LED keeps blinking red. This is extremely frustrating — I've spent 3 hours on this already!",
				timestamp: "2026-02-22T14:30:00Z",
			},
			{
				role: "agent",
				text: "I'm sorry to hear that, Emily. Let me look into this for you. Could you tell me your WiFi network type (2.4GHz or 5GHz)?",
				timestamp: "2026-02-22T15:00:00Z",
			},
			{
				role: "customer",
				text: "It's 5GHz. Why does that matter?",
				timestamp: "2026-02-23T10:00:00Z",
			},
		],
	},
	{
		ticketId: "TKT-8790",
		customerId: "CUST-128",
		subject: "Refund for returned Smart Home Hub",
		status: "open",
		priority: "high",
		category: "billing",
		createdAt: "2026-02-20T11:00:00Z",
		updatedAt: "2026-02-21T09:00:00Z",
		messages: [
			{
				role: "customer",
				text: "I returned my Smart Home Hub Pro over a week ago (order ORD-10031) and still haven't received my refund. This is unacceptable for a VIP customer. I want this resolved immediately.",
				timestamp: "2026-02-20T11:00:00Z",
			},
		],
	},
];

// ── Lookup Functions ─────────────────────────────

function lookupOrder(orderId: string): Order | null {
	return MOCK_ORDERS[orderId.toUpperCase()] ?? null;
}

function lookupOrdersByCustomer(customerId: string): Order[] {
	return Object.values(MOCK_ORDERS).filter((o) => o.customerId === customerId.toUpperCase());
}

function lookupTracking(identifier: string): TrackingInfo | null {
	// Search by order ID or tracking number
	const upper = identifier.toUpperCase();
	for (const order of Object.values(MOCK_ORDERS)) {
		if (order.orderId === upper || order.tracking?.trackingNumber.toUpperCase() === upper) {
			return order.tracking ?? null;
		}
	}
	return null;
}

function lookupCustomer(identifier: string): CustomerRecord | null {
	const upper = identifier.toUpperCase();
	// Search by ID
	if (MOCK_CUSTOMERS[upper]) return MOCK_CUSTOMERS[upper];
	// Search by email
	for (const c of Object.values(MOCK_CUSTOMERS)) {
		if (c.email.toLowerCase() === identifier.toLowerCase()) return c;
	}
	// Search by name
	for (const c of Object.values(MOCK_CUSTOMERS)) {
		if (c.name.toLowerCase().includes(identifier.toLowerCase())) return c;
	}
	return null;
}

function lookupTickets(customerId: string): Ticket[] {
	return MOCK_TICKETS.filter((t) => t.customerId === customerId.toUpperCase());
}

function lookupTicketById(ticketId: string): Ticket | null {
	return MOCK_TICKETS.find((t) => t.ticketId === ticketId.toUpperCase()) ?? null;
}

// ── Policies ─────────────────────────────────────

const POLICIES: Record<string, string> = {
	refund: `**Refund Policy**
- Full refund within 30 days of delivery for unopened items
- Opened items: 30-day return with 15% restocking fee
- Defective items: Full refund + free return shipping, no time limit
- Refunds processed within 5-7 business days after item received
- VIP customers: expedited 2-3 business day refund processing`,

	shipping: `**Shipping Policy**
- Standard: 5-7 business days ($5.99, free over $50)
- Express: 2-3 business days ($14.99)
- International: 10-15 business days ($24.99)
- Tracking provided for all shipments
- If package not delivered within estimated window + 3 days, file a carrier claim`,

	warranty: `**Warranty Policy**
- 1-year manufacturer warranty on all electronics
- 2-year extended warranty available at purchase
- Warranty covers defects in materials and workmanship
- Does NOT cover physical damage, water damage, or misuse
- VIP customers: complimentary 2-year extended warranty`,

	escalation: `**Escalation Policy**
- Tier 1: General inquiries, order status, basic troubleshooting
- Tier 2: Complex technical issues, billing disputes under $200
- Tier 3: Billing disputes over $200, VIP complaints, legal/compliance
- VIP customers: auto-escalate to Tier 2 minimum
- Critical issues (data breach, safety): immediate Tier 3 + notify management`,

	cancellation: `**Cancellation Policy**
- Orders in "processing" status: cancel anytime, full refund
- Orders "shipped": cannot cancel, must wait for delivery and return
- Subscription cancellations: effective at end of current billing period
- No cancellation fees for any tier`,
};

// ── Extension ────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// ── Tool: Lookup Order ───────────────────────
	pi.registerTool({
		name: "cs_lookup_order",
		label: "CS: Lookup Order",
		description:
			"Look up order details by order ID. Returns order status, items, total, customer info, and tracking if available.",
		parameters: Type.Object({
			order_id: Type.String({ description: 'Order ID (e.g., "ORD-10042")' }),
		}),
		async execute(_toolCallId, params) {
			const order = lookupOrder(params.order_id);
			if (!order) {
				return {
					content: [{ type: "text", text: `No order found with ID: ${params.order_id}` }],
					details: { found: false },
					isError: true,
				};
			}
			const text = [
				`Order: ${order.orderId}`,
				`Customer: ${order.customerName} (${order.customerId})`,
				`Email: ${order.customerEmail}`,
				`Status: ${order.status.toUpperCase()}`,
				`Created: ${order.createdAt}`,
				`Items:`,
				...order.items.map((i) => `  - ${i.name} x${i.qty} — $${i.price.toFixed(2)}`),
				`Total: $${order.total.toFixed(2)}`,
			];
			if (order.tracking) {
				text.push(
					``,
					`Tracking: ${order.tracking.carrier} ${order.tracking.trackingNumber}`,
					`Tracking Status: ${order.tracking.status}`,
					`Est. Delivery: ${order.tracking.estimatedDelivery}`
				);
			}
			return {
				content: [{ type: "text", text: text.join("\n") }],
				details: { found: true, order },
			};
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("cs_lookup_order ")) + theme.fg("accent", args.order_id || ""),
				0,
				0
			);
		},
		renderResult(result, { expanded }, theme) {
			if (result.isError) return new Text(theme.fg("error", result.content?.[0]?.text ?? "Not found"), 0, 0);
			const order = result.details?.order as Order;
			if (!order) return new Text(theme.fg("muted", "No data"), 0, 0);
			let text = theme.fg("success", `✓ ${order.orderId}`) + ` — ${order.status.toUpperCase()} — $${order.total.toFixed(2)}`;
			if (expanded) {
				text += "\n" + (result.content?.[0]?.text ?? "");
			}
			return new Text(text, 0, 0);
		},
	});

	// ── Tool: Lookup Tracking ────────────────────
	pi.registerTool({
		name: "cs_lookup_tracking",
		label: "CS: Lookup Tracking",
		description:
			"Look up tracking/shipping details by order ID or tracking number. Returns carrier, status, estimated delivery, and tracking events.",
		parameters: Type.Object({
			identifier: Type.String({ description: "Order ID or tracking number" }),
		}),
		async execute(_toolCallId, params) {
			const tracking = lookupTracking(params.identifier);
			if (!tracking) {
				return {
					content: [{ type: "text", text: `No tracking found for: ${params.identifier}` }],
					details: { found: false },
					isError: true,
				};
			}
			const text = [
				`Carrier: ${tracking.carrier}`,
				`Tracking #: ${tracking.trackingNumber}`,
				`Status: ${tracking.status}`,
				`Est. Delivery: ${tracking.estimatedDelivery}`,
				``,
				`Tracking Events:`,
				...tracking.events.map((e) => `  ${e.date} | ${e.location} | ${e.description}`),
			];
			return {
				content: [{ type: "text", text: text.join("\n") }],
				details: { found: true, tracking },
			};
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("cs_lookup_tracking ")) + theme.fg("accent", args.identifier || ""),
				0,
				0
			);
		},
	});

	// ── Tool: Lookup Customer ────────────────────
	pi.registerTool({
		name: "cs_lookup_customer",
		label: "CS: Lookup Customer",
		description:
			"Look up customer record by customer ID, email, or name. Returns account details, tier, order history summary, and notes.",
		parameters: Type.Object({
			identifier: Type.String({ description: "Customer ID, email address, or name" }),
		}),
		async execute(_toolCallId, params) {
			const customer = lookupCustomer(params.identifier);
			if (!customer) {
				return {
					content: [{ type: "text", text: `No customer found for: ${params.identifier}` }],
					details: { found: false },
					isError: true,
				};
			}
			const text = [
				`Customer ID: ${customer.customerId}`,
				`Name: ${customer.name}`,
				`Email: ${customer.email}`,
				`Phone: ${customer.phone}`,
				`Tier: ${customer.tier.toUpperCase()}`,
				`Account Created: ${customer.accountCreated}`,
				`Total Orders: ${customer.totalOrders}`,
				`Open Tickets: ${customer.openTickets}`,
				...(customer.notes.length > 0 ? [`Notes:`, ...customer.notes.map((n) => `  • ${n}`)] : []),
			];
			return {
				content: [{ type: "text", text: text.join("\n") }],
				details: { found: true, customer },
			};
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("cs_lookup_customer ")) + theme.fg("accent", args.identifier || ""),
				0,
				0
			);
		},
		renderResult(result, { expanded }, theme) {
			if (result.isError) return new Text(theme.fg("error", result.content?.[0]?.text ?? "Not found"), 0, 0);
			const c = result.details?.customer as CustomerRecord;
			if (!c) return new Text(theme.fg("muted", "No data"), 0, 0);
			const tierColor = c.tier === "vip" ? "error" : c.tier === "premium" ? "warning" : "muted";
			let text = theme.fg("success", `✓ ${c.name}`) + ` [${theme.fg(tierColor, c.tier.toUpperCase())}] — ${c.totalOrders} orders`;
			if (expanded) {
				text += "\n" + (result.content?.[0]?.text ?? "");
			}
			return new Text(text, 0, 0);
		},
	});

	// ── Tool: Lookup Ticket ──────────────────────
	pi.registerTool({
		name: "cs_lookup_ticket",
		label: "CS: Lookup Ticket",
		description:
			"Look up a support ticket by ticket ID. Returns ticket details including full conversation history.",
		parameters: Type.Object({
			ticket_id: Type.String({ description: 'Ticket ID (e.g., "TKT-8801")' }),
		}),
		async execute(_toolCallId, params) {
			const ticket = lookupTicketById(params.ticket_id);
			if (!ticket) {
				return {
					content: [{ type: "text", text: `No ticket found with ID: ${params.ticket_id}` }],
					details: { found: false },
					isError: true,
				};
			}
			const text = [
				`Ticket: ${ticket.ticketId}`,
				`Customer: ${ticket.customerId}`,
				`Subject: ${ticket.subject}`,
				`Status: ${ticket.status.toUpperCase()}`,
				`Priority: ${ticket.priority.toUpperCase()}`,
				`Category: ${ticket.category}`,
				`Created: ${ticket.createdAt}`,
				`Updated: ${ticket.updatedAt}`,
				``,
				`Conversation:`,
				...ticket.messages.map((m) => `  [${m.role.toUpperCase()} — ${m.timestamp}]\n  ${m.text}`),
			];
			return {
				content: [{ type: "text", text: text.join("\n") }],
				details: { found: true, ticket },
			};
		},
	});

	// ── Tool: Customer Tickets ───────────────────
	pi.registerTool({
		name: "cs_customer_tickets",
		label: "CS: Customer Tickets",
		description: "List all support tickets for a customer. Use to see open/pending issues and history.",
		parameters: Type.Object({
			customer_id: Type.String({ description: "Customer ID" }),
		}),
		async execute(_toolCallId, params) {
			const tickets = lookupTickets(params.customer_id);
			if (tickets.length === 0) {
				return {
					content: [{ type: "text", text: `No tickets found for customer: ${params.customer_id}` }],
					details: { found: false, count: 0 },
				};
			}
			const text = [
				`Found ${tickets.length} ticket(s) for ${params.customer_id}:`,
				``,
				...tickets.map(
					(t) =>
						`  ${t.ticketId} | ${t.status.toUpperCase().padEnd(8)} | ${t.priority.toUpperCase().padEnd(8)} | ${t.category.padEnd(12)} | ${t.subject}`
				),
			];
			return {
				content: [{ type: "text", text: text.join("\n") }],
				details: { found: true, count: tickets.length, tickets },
			};
		},
	});

	// ── Tool: Get Policy ─────────────────────────
	pi.registerTool({
		name: "cs_get_policy",
		label: "CS: Get Policy",
		description:
			"Retrieve company policy documentation. Available policies: refund, shipping, warranty, escalation, cancellation. Use this to ensure responses align with official policy.",
		parameters: Type.Object({
			policy: StringEnum(["refund", "shipping", "warranty", "escalation", "cancellation"] as const, {
				description: "Policy name to retrieve",
			}),
		}),
		async execute(_toolCallId, params) {
			const policy = POLICIES[params.policy];
			if (!policy) {
				return {
					content: [{ type: "text", text: `Unknown policy: ${params.policy}` }],
					isError: true,
				};
			}
			return {
				content: [{ type: "text", text: policy }],
				details: { policy: params.policy },
			};
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("cs_get_policy ")) + theme.fg("accent", args.policy || ""),
				0,
				0
			);
		},
	});

	// ── Tool: Customer Orders ────────────────────
	pi.registerTool({
		name: "cs_customer_orders",
		label: "CS: Customer Orders",
		description: "List all orders for a customer by customer ID.",
		parameters: Type.Object({
			customer_id: Type.String({ description: "Customer ID" }),
		}),
		async execute(_toolCallId, params) {
			const orders = lookupOrdersByCustomer(params.customer_id);
			if (orders.length === 0) {
				return {
					content: [{ type: "text", text: `No orders found for customer: ${params.customer_id}` }],
					details: { found: false, count: 0 },
				};
			}
			const text = [
				`Found ${orders.length} order(s) for ${params.customer_id}:`,
				``,
				...orders.map(
					(o) =>
						`  ${o.orderId} | ${o.status.toUpperCase().padEnd(10)} | $${o.total.toFixed(2).padStart(8)} | ${o.createdAt.split("T")[0]} | ${o.items.map((i) => i.name).join(", ")}`
				),
			];
			return {
				content: [{ type: "text", text: text.join("\n") }],
				details: { found: true, count: orders.length, orders },
			};
		},
	});

	// ── System Prompt Injection ──────────────────
	pi.on("before_agent_start", async (event) => {
		return {
			systemPrompt:
				event.systemPrompt +
				`\n\n## Customer Support Agent

You are a customer support agent. When a user presents a customer message or support scenario:

1. **Triage** — Analyze the message to understand intent, sentiment, and urgency
2. **Lookup** — Use cs_lookup_order, cs_lookup_tracking, cs_lookup_customer, cs_customer_tickets, and cs_customer_orders to gather relevant data
3. **Policy check** — Use cs_get_policy to verify you're following company guidelines
4. **Troubleshoot** — For technical issues, work through diagnostic steps
5. **Respond** — Draft a professional, empathetic customer-facing response

Always look up the customer and order details before responding. Reference specific data in your response. Follow company policies strictly.

Available tools:
- cs_lookup_order: Get order details by order ID
- cs_lookup_tracking: Get shipping/tracking info by order ID or tracking number
- cs_lookup_customer: Get customer profile by ID, email, or name
- cs_lookup_ticket: Get a specific ticket's full details
- cs_customer_tickets: List all tickets for a customer
- cs_customer_orders: List all orders for a customer
- cs_get_policy: Retrieve company policy (refund, shipping, warranty, escalation, cancellation)

When presenting your response, clearly separate your **internal analysis** from the **customer-facing draft response**.`,
		};
	});

	// ── Commands ─────────────────────────────────

	pi.registerCommand("cs-history", {
		description: "Show recent tickets for a customer (usage: /cs-history CUST-301)",
		handler: async (args, ctx) => {
			if (!args?.trim()) {
				ctx.ui.notify("Usage: /cs-history <customer_id>", "warning");
				return;
			}
			const tickets = lookupTickets(args.trim());
			if (tickets.length === 0) {
				ctx.ui.notify(`No tickets found for ${args.trim()}`, "info");
				return;
			}
			const lines = tickets.map(
				(t) => `${t.ticketId} [${t.status}] ${t.priority} — ${t.subject}`
			);
			ctx.ui.notify(`Tickets for ${args.trim()}:\n${lines.join("\n")}`, "info");
		},
	});

	pi.registerCommand("cs-stats", {
		description: "Show support queue statistics",
		handler: async (_args, ctx) => {
			const open = MOCK_TICKETS.filter((t) => t.status === "open").length;
			const pending = MOCK_TICKETS.filter((t) => t.status === "pending").length;
			const high = MOCK_TICKETS.filter((t) => t.priority === "high" || t.priority === "critical").length;
			ctx.ui.notify(
				`Support Queue:\n  Open: ${open}\n  Pending: ${pending}\n  High/Critical: ${high}\n  Total: ${MOCK_TICKETS.length}`,
				"info"
			);
		},
	});

	// ── Session Start ────────────────────────────
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setStatus("cs-agent", "🎧 CS Agent Active");
	});
}
