import os
import struct

def generate_svg(filename, title, subtitle, scene1_title, scene1_body, scene2_title, scene2_body, scene3_title, scene3_body, badge_text, badge_color):
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 480" width="100%" height="100%">
  <defs>
    <style>
      @keyframes cycleScenes {{
        0%, 30% {{ opacity: 1; transform: translateY(0); }}
        33%, 97% {{ opacity: 0; transform: translateY(10px); }}
        100% {{ opacity: 1; transform: translateY(0); }}
      }}
      @keyframes sceneTwo {{
        0%, 30% {{ opacity: 0; transform: translateY(-10px); }}
        35%, 65% {{ opacity: 1; transform: translateY(0); }}
        68%, 100% {{ opacity: 0; transform: translateY(10px); }}
      }}
      @keyframes sceneThree {{
        0%, 65% {{ opacity: 0; transform: translateY(-10px); }}
        70%, 97% {{ opacity: 1; transform: translateY(0); }}
        100% {{ opacity: 0; transform: translateY(10px); }}
      }}
      @keyframes pulseBadge {{
        0%, 100% {{ transform: scale(1); opacity: 0.95; }}
        50% {{ transform: scale(1.05); opacity: 1; }}
      }}
      @keyframes progressBar {{
        0% {{ width: 0%; }}
        33% {{ width: 33%; }}
        66% {{ width: 66%; }}
        100% {{ width: 100%; }}
      }}
      .scene-1 {{ animation: cycleScenes 12s infinite; }}
      .scene-2 {{ animation: sceneTwo 12s infinite; }}
      .scene-3 {{ animation: sceneThree 12s infinite; }}
      .pulse {{ animation: pulseBadge 2s infinite ease-in-out; transform-origin: center; }}
      .progress {{ animation: progressBar 12s linear infinite; }}
    </style>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0b0f19" />
      <stop offset="100%" stop-color="#1e293b" />
    </linearGradient>
    <linearGradient id="cardGrad" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#1e293b" />
      <stop offset="100%" stop-color="#0f172a" />
    </linearGradient>
    <linearGradient id="accentGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#3b82f6" />
      <stop offset="100%" stop-color="#10b981" />
    </linearGradient>
    <filter id="shadow" x="-5%" y="-5%" width="110%" height="110%">
      <feDropShadow dx="0" dy="6" stdDeviation="12" flood-color="#000000" flood-opacity="0.4" />
    </filter>
  </defs>

  <!-- Background -->
  <rect width="800" height="480" fill="url(#bgGrad)" rx="16" />

  <!-- Window Chrome Header -->
  <rect width="800" height="44" fill="#0f172a" rx="16" />
  <rect y="30" width="800" height="14" fill="#0f172a" />
  <line x1="0" y1="44" x2="800" y2="44" stroke="#334155" stroke-width="1" />
  
  <!-- Window Dots -->
  <circle cx="24" cy="22" r="6" fill="#ef4444" />
  <circle cx="44" cy="22" r="6" fill="#f59e0b" />
  <circle cx="64" cy="22" r="6" fill="#10b981" />

  <!-- URL Bar -->
  <rect x="180" y="10" width="440" height="24" rx="6" fill="#1e293b" stroke="#334155" stroke-width="1" />
  <text x="400" y="26" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="11" fill="#94a3b8" text-anchor="middle">
    🔒 https://accord-protocol.vercel.app/testnet
  </text>

  <!-- Network Badge -->
  <rect x="680" y="12" width="90" height="20" rx="10" fill="#065f46" stroke="#10b981" stroke-width="1" />
  <circle cx="692" cy="22" r="4" fill="#34d399" />
  <text x="734" y="26" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="10" font-weight="600" fill="#a7f3d0" text-anchor="middle">TESTNET</text>

  <!-- Top Hero / Banner -->
  <text x="40" y="85" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="20" font-weight="700" fill="#f8fafc">{title}</text>
  <text x="40" y="108" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="13" fill="#94a3b8">{subtitle}</text>

  <!-- Status / Flow Badge -->
  <g class="pulse">
    <rect x="620" y="70" width="140" height="28" rx="14" fill="{badge_color}" opacity="0.2" />
    <rect x="620" y="70" width="140" height="28" rx="14" fill="none" stroke="{badge_color}" stroke-width="1.5" />
    <text x="690" y="88" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="11" font-weight="700" fill="{badge_color}" text-anchor="middle">{badge_text}</text>
  </g>

  <!-- Main Canvas / Workspace Box -->
  <g filter="url(#shadow)">
    <rect x="40" y="130" width="720" height="300" rx="12" fill="url(#cardGrad)" stroke="#334155" stroke-width="1" />
  </g>

  <!-- Animated Timeline / Progress Indicator at Bottom of Card -->
  <rect x="40" y="426" width="720" height="4" fill="#1e293b" />
  <rect x="40" y="426" width="0" height="4" fill="url(#accentGrad)" class="progress" />

  <!-- SCENE 1 -->
  <g class="scene-1">
    <rect x="60" y="150" width="220" height="32" rx="6" fill="#3b82f6" opacity="0.15" />
    <text x="75" y="171" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="13" font-weight="700" fill="#60a5fa">Step 1: {scene1_title}</text>
    
    <rect x="60" y="200" width="680" height="200" rx="8" fill="#0f172a" stroke="#1e293b" stroke-width="1" />
    {scene1_body}
  </g>

  <!-- SCENE 2 -->
  <g class="scene-2">
    <rect x="60" y="150" width="220" height="32" rx="6" fill="#f59e0b" opacity="0.15" />
    <text x="75" y="171" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="13" font-weight="700" fill="#fbbf24">Step 2: {scene2_title}</text>
    
    <rect x="60" y="200" width="680" height="200" rx="8" fill="#0f172a" stroke="#1e293b" stroke-width="1" />
    {scene2_body}
  </g>

  <!-- SCENE 3 -->
  <g class="scene-3">
    <rect x="60" y="150" width="220" height="32" rx="6" fill="#10b981" opacity="0.15" />
    <text x="75" y="171" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="13" font-weight="700" fill="#34d399">Step 3: {scene3_title}</text>
    
    <rect x="60" y="200" width="680" height="200" rx="8" fill="#0f172a" stroke="#1e293b" stroke-width="1" />
    {scene3_body}
  </g>

  <!-- Step indicators -->
  <circle cx="370" cy="455" r="4" fill="#3b82f6" />
  <circle cx="400" cy="455" r="4" fill="#f59e0b" />
  <circle cx="430" cy="455" r="4" fill="#10b981" />
</svg>"""
    with open(filename, 'w') as f:
        f.write(svg)
    print("Wrote SVG:", filename)

def generate_gif(filename, width, height, num_frames, title_text, step_texts):
    # Generates a valid multi-frame GIF89a file
    out = bytearray(b'GIF89a')
    out += struct.pack('<HH', width, height)
    out += b'\xf7\x00\x00' # Global Color Table flag (256 colors)
    
    # 256 colors palette
    palette = [
        (11, 15, 25),    # 0: Dark slate bg
        (30, 41, 59),    # 1: Slate card
        (59, 130, 246),  # 2: Blue accent
        (16, 185, 129),  # 3: Emerald green
        (245, 158, 11),  # 4: Amber
        (239, 68, 68),   # 5: Red
        (248, 250, 252), # 6: White text
        (148, 163, 184), # 7: Slate light text
        (15, 23, 42),    # 8: Header dark
        (51, 65, 85),    # 9: Border slate
    ]
    pal_bytes = bytearray()
    for c in palette:
        pal_bytes += bytes(c)
    while len(pal_bytes) < 256 * 3:
        pal_bytes += b'\x00'
    out += pal_bytes

    # Looping animation block
    out += b'\x21\xff\x0bNETSCAPE2.0\x03\x01\x00\x00\x00'

    for step_idx in range(num_frames):
        # 100 hundredths of a second = 1 second per step
        delay = 140
        out += b'\x21\xf9\x04\x00' + struct.pack('<H', delay) + b'\x00\x00'
        out += b'\x2c' + struct.pack('<HHHH', 0, 0, width, height) + b'\x00'
        
        # Build frame raster
        # Canvas filled with dark slate
        pixels = [0] * (width * height)
        # Header bar
        for y in range(30):
            for x in range(width):
                pixels[y * width + x] = 8
        # Border line
        for x in range(width):
            pixels[30 * width + x] = 9
            pixels[(height - 10) * width + x] = 9
        # Card inner area
        card_margin_x = 20
        card_margin_y = 50
        for y in range(card_margin_y, height - 30):
            for x in range(card_margin_x, width - card_margin_x):
                pixels[y * width + x] = 1
        
        # Color indicator based on step
        active_color = 2 if step_idx == 0 else (4 if step_idx == 1 else 3)
        # Draw a highlighted step bar
        bar_y_start = card_margin_y + 10
        bar_y_end = bar_y_start + 8
        step_w = (width - 2 * card_margin_x) // 3
        bar_x_start = card_margin_x + step_idx * step_w
        bar_x_end = bar_x_start + step_w
        for y in range(bar_y_start, bar_y_end):
            for x in range(bar_x_start, bar_x_end):
                pixels[y * width + x] = active_color

        # LZW packing
        min_code_size = 8
        out += bytes([min_code_size])
        clear_code = 1 << min_code_size
        end_code = clear_code + 1
        bit_buffer = 0
        bit_count = 0
        code_size = min_code_size + 1
        subblock = bytearray()

        def write_code(c):
            nonlocal bit_buffer, bit_count, code_size, subblock, out
            bit_buffer |= (c << bit_count)
            bit_count += code_size
            while bit_count >= 8:
                subblock.append(bit_buffer & 0xff)
                bit_buffer >>= 8
                bit_count -= 8
                if len(subblock) == 254:
                    out.append(len(subblock))
                    out += subblock
                    subblock = bytearray()

        write_code(clear_code)
        for p in pixels:
            write_code(p)
        write_code(end_code)
        if bit_count > 0:
            subblock.append(bit_buffer & 0xff)
        if len(subblock) > 0:
            out.append(len(subblock))
            out += subblock
        out.append(0)

    out += b'\x3b' # Trailer
    with open(filename, 'wb') as f:
        f.write(out)
    print("Wrote GIF:", filename, "size:", len(out))

os.makedirs('docs/assets/walkthroughs', exist_ok=True)

# 1. Onboarding & Wallet Connection
generate_svg(
    'docs/assets/walkthroughs/01-wallet-connection-onboarding.svg',
    'Walkthrough: Onboarding & Wallet Connection',
    'Connect Freighter extension, select Stellar Testnet, and fund account',
    'Install & Switch to Testnet',
    '''
    <text x="90" y="240" font-family="sans-serif" font-size="14" font-weight="600" fill="#f8fafc">1. Open Freighter extension and switch network to Testnet</text>
    <rect x="90" y="260" width="280" height="40" rx="8" fill="#1e293b" stroke="#3b82f6" stroke-width="1.5" />
    <text x="110" y="285" font-family="sans-serif" font-size="13" fill="#93c5fd">Network: Stellar Testnet (Active)</text>
    <text x="90" y="330" font-family="sans-serif" font-size="13" fill="#94a3b8">Testnet provides free XLM test tokens without real funds risk.</text>
    ''',
    'Fund via Friendbot',
    '''
    <text x="90" y="240" font-family="sans-serif" font-size="14" font-weight="600" fill="#f8fafc">2. Request 10,000 Testnet XLM via Friendbot faucet</text>
    <rect x="90" y="260" width="340" height="40" rx="8" fill="#1e293b" stroke="#f59e0b" stroke-width="1.5" />
    <text x="110" y="285" font-family="sans-serif" font-size="13" fill="#fde68a">Balance: 10,000.0000000 XLM funded</text>
    <text x="90" y="330" font-family="sans-serif" font-size="13" fill="#94a3b8">Your account is now activated on ledger and ready to sign.</text>
    ''',
    'Connect to Accord Protocol',
    '''
    <text x="90" y="240" font-family="sans-serif" font-size="14" font-weight="600" fill="#f8fafc">3. Click "Connect Wallet" on Accord dApp header</text>
    <rect x="90" y="260" width="380" height="40" rx="8" fill="#065f46" stroke="#10b981" stroke-width="1.5" />
    <text x="110" y="285" font-family="sans-serif" font-size="13" fill="#a7f3d0">Connected: GABC...7XYZ | Role: Owner (Weight 30)</text>
    <text x="90" y="330" font-family="sans-serif" font-size="13" fill="#94a3b8">Dashboard unlocks with live treasury metrics and proposal controls.</text>
    ''',
    'ONBOARDING FLOW',
    '#3b82f6'
)

# 2. Proposal Creation
generate_svg(
    'docs/assets/walkthroughs/02-create-multisig-proposal.svg',
    'Walkthrough: Creating a Multisig Proposal',
    'Draft transfer or configuration proposals with validation and preview',
    'Click "New Proposal"',
    '''
    <text x="90" y="240" font-family="sans-serif" font-size="14" font-weight="600" fill="#f8fafc">1. Navigate to Proposals and trigger creation modal</text>
    <rect x="90" y="260" width="220" height="38" rx="6" fill="#3b82f6" />
    <text x="135" y="284" font-family="sans-serif" font-size="13" font-weight="600" fill="#ffffff">+ Create Proposal</text>
    <text x="90" y="330" font-family="sans-serif" font-size="13" fill="#94a3b8">Only accounts registered in the owners map can propose.</text>
    ''',
    'Configure Parameters & Recipient',
    '''
    <text x="90" y="235" font-family="sans-serif" font-size="14" font-weight="600" fill="#f8fafc">2. Input recipient address, amount, asset, and reason</text>
    <rect x="90" y="250" width="360" height="28" rx="4" fill="#1e293b" stroke="#475569" stroke-width="1" />
    <text x="100" y="269" font-family="sans-serif" font-size="12" fill="#cbd5e1">To: GDQP...8LKJ (Audit Bounty)</text>
    <rect x="90" y="285" width="160" height="28" rx="4" fill="#1e293b" stroke="#475569" stroke-width="1" />
    <text x="100" y="304" font-family="sans-serif" font-size="12" fill="#cbd5e1">Amount: 500 USDC</text>
    <text x="90" y="340" font-family="sans-serif" font-size="13" fill="#94a3b8">Validation checks contract balance and enforces 300 char description max.</text>
    ''',
    'Simulate & Sign On-Chain',
    '''
    <text x="90" y="240" font-family="sans-serif" font-size="14" font-weight="600" fill="#f8fafc">3. Soroban RPC simulates tx, Freighter prompts signature</text>
    <rect x="90" y="260" width="380" height="40" rx="8" fill="#1e293b" stroke="#10b981" stroke-width="1.5" />
    <text x="110" y="285" font-family="sans-serif" font-size="13" fill="#34d399">✓ Proposal #14 Created: Status PENDING (0/3 Approved)</text>
    <text x="90" y="330" font-family="sans-serif" font-size="13" fill="#94a3b8">Active proposal count updated, event emitted to indexer.</text>
    ''',
    'PROPOSAL LIFECYCLE',
    '#f59e0b'
)

# 3. Approve and Execute
generate_svg(
    'docs/assets/walkthroughs/03-approve-and-execute-proposal.svg',
    'Walkthrough: Reviewing, Approving & Executing',
    'Gather owner signatures and execute on-chain once threshold is met',
    'Review Pending Proposal',
    '''
    <text x="90" y="240" font-family="sans-serif" font-size="14" font-weight="600" fill="#f8fafc">1. Co-owners review proposal card details and deadline</text>
    <rect x="90" y="260" width="400" height="42" rx="6" fill="#1e293b" stroke="#334155" stroke-width="1" />
    <text x="105" y="286" font-family="sans-serif" font-size="13" fill="#f8fafc">Proposal #14 — 500 USDC to GDQP...8LKJ</text>
    <text x="90" y="330" font-family="sans-serif" font-size="13" fill="#94a3b8">Progress: 1 / 3 approvals (Weight: 20 / 60)</text>
    ''',
    'Sign Approval with Freighter',
    '''
    <text x="90" y="240" font-family="sans-serif" font-size="14" font-weight="600" fill="#f8fafc">2. Click "Approve" -> signs invokeHostFunction in wallet</text>
    <rect x="90" y="260" width="420" height="42" rx="6" fill="#1e293b" stroke="#f59e0b" stroke-width="1.5" />
    <text x="105" y="286" font-family="sans-serif" font-size="13" fill="#fde68a">Status: READY TO EXECUTE (3 / 3 Approvals Met)</text>
    <text x="90" y="330" font-family="sans-serif" font-size="13" fill="#94a3b8">Quorum reached: status transitions on-chain automatically.</text>
    ''',
    'Execute On-Chain Transfer',
    '''
    <text x="90" y="240" font-family="sans-serif" font-size="14" font-weight="600" fill="#f8fafc">3. Any owner clicks "Execute" -> contract transfers tokens</text>
    <rect x="90" y="260" width="380" height="42" rx="6" fill="#065f46" stroke="#10b981" stroke-width="1.5" />
    <text x="105" y="286" font-family="sans-serif" font-size="13" fill="#a7f3d0">✓ Status: EXECUTED (Tx: 9a4f...31bc)</text>
    <text x="90" y="330" font-family="sans-serif" font-size="13" fill="#94a3b8">Tokens sent directly to recipient from contract escrow.</text>
    ''',
    'APPROVAL & EXECUTION',
    '#10b981'
)

# 4. Recurring Payments
generate_svg(
    'docs/assets/walkthroughs/04-recurring-payroll-schedule.svg',
    'Walkthrough: Recurring Payments & Payroll',
    'Automate contributor streams, vesting schedules, and batch payroll',
    'Configure Stream Schedule',
    '''
    <text x="90" y="240" font-family="sans-serif" font-size="14" font-weight="600" fill="#f8fafc">1. Set disbursement interval, start time, and total cap</text>
    <rect x="90" y="260" width="380" height="38" rx="6" fill="#1e293b" stroke="#6366f1" stroke-width="1" />
    <text x="105" y="284" font-family="sans-serif" font-size="13" fill="#c7d2fe">Interval: 30 Days | Amount: 2,500 USDC | Cap: 30,000 USDC</text>
    <text x="90" y="330" font-family="sans-serif" font-size="13" fill="#94a3b8">Supports Fixed Period Payouts or Linear Vesting with Cliffs.</text>
    ''',
    'Owner Consensus Approval',
    '''
    <text x="90" y="240" font-family="sans-serif" font-size="14" font-weight="600" fill="#f8fafc">2. Multisig owners review and sign stream proposal</text>
    <rect x="90" y="260" width="400" height="38" rx="6" fill="#1e293b" stroke="#f59e0b" stroke-width="1" />
    <text x="105" y="284" font-family="sans-serif" font-size="13" fill="#fde68a">Proposal #18 (CreateRecurring) Approved & Activated</text>
    <text x="90" y="330" font-family="sans-serif" font-size="13" fill="#94a3b8">Contract records schedule under persistent storage ("RECUR", id).</text>
    ''',
    'Autonomous Execution & History',
    '''
    <text x="90" y="240" font-family="sans-serif" font-size="14" font-weight="600" fill="#f8fafc">3. Trigger disbursement or let automated crank disburse</text>
    <rect x="90" y="260" width="420" height="38" rx="6" fill="#065f46" stroke="#10b981" stroke-width="1.5" />
    <text x="105" y="284" font-family="sans-serif" font-size="13" fill="#a7f3d0">Disbursed Period #1: 2,500 USDC | Next due in: 29d 23h</text>
    <text x="90" y="330" font-family="sans-serif" font-size="13" fill="#94a3b8">Includes emergency Pause, Resume, and Cancel safeguards.</text>
    ''',
    'PAYROLL STREAMING',
    '#6366f1'
)

# 5. Treasury Analytics
generate_svg(
    'docs/assets/walkthroughs/05-treasury-analytics-monitoring.svg',
    'Walkthrough: Treasury Analytics & Monitoring',
    'Track asset balances, proposal throughput, and live on-chain event stream',
    'Treasury Overview & Balances',
    '''
    <text x="90" y="240" font-family="sans-serif" font-size="14" font-weight="600" fill="#f8fafc">1. Inspect multi-token reserves and historical expenditure</text>
    <rect x="90" y="260" width="420" height="38" rx="6" fill="#1e293b" stroke="#38bdf8" stroke-width="1" />
    <text x="105" y="284" font-family="sans-serif" font-size="13" fill="#bae6fd">Total Treasury: $128,450 | XLM: 85,000 | USDC: 72,000</text>
    <text x="90" y="330" font-family="sans-serif" font-size="13" fill="#94a3b8">Aggregates all contract SEP-41 classic & SAC token holdings.</text>
    ''',
    'Governance & Quorum Analytics',
    '''
    <text x="90" y="240" font-family="sans-serif" font-size="14" font-weight="600" fill="#f8fafc">2. View owner participation rates and quorum health</text>
    <rect x="90" y="260" width="400" height="38" rx="6" fill="#1e293b" stroke="#a855f7" stroke-width="1" />
    <text x="105" y="284" font-family="sans-serif" font-size="13" fill="#e9d5ff">Avg Quorum Time: 4.2h | Active Owners: 5 / 5 (100%)</text>
    <text x="90" y="330" font-family="sans-serif" font-size="13" fill="#94a3b8">Spots bottleneck approvers and tracks execution velocity.</text>
    ''',
    'Real-time Indexer Feed',
    '''
    <text x="90" y="240" font-family="sans-serif" font-size="14" font-weight="600" fill="#f8fafc">3. Inspect raw event topic payloads and audit trails</text>
    <rect x="90" y="260" width="440" height="38" rx="6" fill="#065f46" stroke="#10b981" stroke-width="1.5" />
    <text x="105" y="284" font-family="sans-serif" font-size="13" fill="#a7f3d0">Live Feed: created #14 -> approved (w=30) -> executed</text>
    <text x="90" y="330" font-family="sans-serif" font-size="13" fill="#94a3b8">Export CSV/PDF records for off-chain accounting and tax reporting.</text>
    ''',
    'ANALYTICS & AUDIT',
    '#38bdf8'
)

# Also generate corresponding animated GIFs for maximum compatibility
generate_gif('docs/assets/walkthroughs/01-wallet-connection-onboarding.gif', 320, 200, 3, 'Onboarding', ['Testnet', 'Fund', 'Connect'])
generate_gif('docs/assets/walkthroughs/02-create-multisig-proposal.gif', 320, 200, 3, 'Create Proposal', ['New', 'Params', 'Simulate'])
generate_gif('docs/assets/walkthroughs/03-approve-and-execute-proposal.gif', 320, 200, 3, 'Approve & Execute', ['Review', 'Approve', 'Execute'])
generate_gif('docs/assets/walkthroughs/04-recurring-payroll-schedule.gif', 320, 200, 3, 'Payroll Stream', ['Config', 'Consensus', 'Disburse'])
generate_gif('docs/assets/walkthroughs/05-treasury-analytics-monitoring.gif', 320, 200, 3, 'Analytics & Audit', ['Overview', 'Quorum', 'Event Feed'])

print("All walkthrough assets generated successfully.")
