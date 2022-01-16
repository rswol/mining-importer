import sha512 from 'js-sha512'
import Database from 'better-sqlite3'
import c32 from 'c32check'
import {STACKS_NODE_SQLITE_PATH} from "../common/constants";


function Sha512Trunc256Sum(block_hash, consensus_hash) {
    return sha512.sha512_256(Buffer.concat([block_hash, consensus_hash]))
}

export async function importData(block_height) {
    const sortition_db_path = "burnchain/sortition/marf.sqlite"

    const vm_db_path = "chainstate/vm/index.sqlite"

    const data_root_path = STACKS_NODE_SQLITE_PATH
    console.log(data_root_path)

    const sortition_db = new Database(`${data_root_path}/${sortition_db_path}`, {
        readonly: true,
        fileMustExist: true,
    })

    const headers_db = new Database(`${data_root_path}/${vm_db_path}`, {
        readonly: true,
        fileMustExist: true,
    })

    // sortition queries
    const stmt_all_blocks = sortition_db.prepare(`SELECT * FROM snapshots WHERE block_height > ${block_height} order by block_height desc `)
    console.log(stmt_all_blocks)
    const stmt_all_block_commits = sortition_db.prepare(`SELECT * FROM block_commits WHERE block_height > ${block_height} order by block_height`)
    console.log(stmt_all_block_commits)
    const stmt_all_leader_keys = sortition_db.prepare(`SELECT * FROM leader_keys WHERE block_height > ${block_height} order by block_height`)
    console.log(stmt_all_leader_keys)

    // header queries
    const stmt_all_block_headers = headers_db.prepare(`SELECT * FROM block_headers WHERE block_height > ${block_height} order by block_height`)
    // stacks_block_height
    const stmt_all_payments = headers_db.prepare('SELECT * FROM payments')

    let stacks_blocks_by_height = []
    let burn_blocks_by_height = []
    let burn_blocks_by_burn_header_hash = {}
    let burn_blocks_by_consensus_hash = {}
    let stacks_blocks_by_stacks_block_hash = {}
    let blocks_commit_info = {}
    let miners = {}
    let actual_win_total = 0
    let win_total = 0

    const branches = [
        {
            tip: '0000000000000000000000000000000000000000000000000000000000000000',
            name: 'br1',
            index: 1,
            height_created: 0,
            seen: 0,
            last_seen: '',
            depth: 0,
        },
    ]

    function branch_from_parent(block_hash, parent_hash) {
        const branch_info = branches.find(b => b.tip === parent_hash)
        if (branch_info) {
            branch_info.tip = block_hash
            branch_info.last_seen = stacks_blocks_by_stacks_block_hash[block_hash].block_height
            branch_info.seen++
            branch_info.depth++
            return branch_info
        }
        const current_height = stacks_blocks_by_stacks_block_hash[parent_hash] ? stacks_blocks_by_stacks_block_hash[parent_hash].block_height : 1
        const new_branch_info = {
            tip: block_hash,
            name: `br${branches.length + 1}`,
            index: branches.length + 1,
            height_created: current_height,
            seen: 1,
            last_seen: stacks_blocks_by_stacks_block_hash[block_hash].block_height,
            depth: current_height + 1,
        }
        branches.push(new_branch_info)
        return new_branch_info
    }

    function find_leader_key(block_height, vtxindex) {
        const block = burn_blocks_by_height[block_height]
        const leader_key = block.leader_keys.find(lk => lk.vtxindex === vtxindex)
        if (!leader_key) {
            console.log("leader_key not found", block_height, vtxindex)
        }
        return leader_key
    }

    function post_process_block_commits() {
        for (let blockindex of Object.keys(burn_blocks_by_height)) {
            let block = burn_blocks_by_height[blockindex]
            //console.log("burn_blocks_by_height:", typeof(burn_blocks_by_height))
            //console.log("burn_blocks_by_height keys:",Object.keys(burn_blocks_by_height))
            //console.log("block:", block)
            for (let block_commit of block.block_commits) {
                block_commit.leader_key = find_leader_key(block_commit.key_block_ptr, block_commit.key_vtxindex)
                block_commit.leader_key_address = block_commit.leader_key.address
            }
        }
    }

    function process_snapshots() {
        const result = stmt_all_blocks.all()
        let parent = undefined
        let tempG = undefined
        for (let row of result) {
            if (row.pox_valid === 0) {
                //console.log("pox invalid", row.block_height, row.burn_header_hash, parent.parent_burn_header_hash)
            }
            else if (!parent || row.burn_header_hash === parent.parent_burn_header_hash) {
                burn_blocks_by_height[row.block_height] = row
                burn_blocks_by_burn_header_hash[row.burn_header_hash] = row
                row.block_commits = []
                row.leader_keys = []
                row.payments = []
                row.staging_blocks = []
                row.block_headers = []
                parent = row
            } else {
                console.log("no match", row.block_height, row.burn_header_hash, parent.parent_burn_header_hash)
            }
            tempG = row
        }

        if (burn_blocks_by_height.filter(b => !b).length !== 0) {
            console.log("missing blocks", burn_blocks_by_height.filter(b => !b))
            process.exit()
        }
        console.log("latest snap shot:", tempG)
        console.log("Burnchain Height:", burn_blocks_by_height.length)

    }

    function process_leader_keys() {
        const result = stmt_all_leader_keys.all()
        // console.log("leader_keys", result)
        // console.log("process_leader_keys.length", result.length)
        for (let row of result) {
            if (burn_blocks_by_burn_header_hash[row.burn_header_hash]) {
                burn_blocks_by_burn_header_hash[row.burn_header_hash].leader_keys.push(row)
            }
        }
    }

    function process_block_commits() {
        const result = stmt_all_block_commits.all()
        // console.log("block_commits", result)
        // console.log("process_block_commits.length", result.length)
        for (let row of result) {
            if (burn_blocks_by_burn_header_hash[row.burn_header_hash]) {
                burn_blocks_by_burn_header_hash[row.burn_header_hash].block_commits.push(row)
            }
        }
    }

    function process_payments() {
        const result = stmt_all_payments.all()
        // console.log("payments", result)
        // console.log("payments.length", result.length)
        // console.log("burn_blocks_by_consensus_hash", burn_blocks_by_consensus_hash)
        for (let row of result) {
            // console.log(row.burn_header_hash, row)
            if (burn_blocks_by_consensus_hash[row.consensus_hash] === undefined) continue;
            burn_blocks_by_consensus_hash[row.consensus_hash].payments.push(row)
        }
    }

    function process_block_headers() {
        const result = stmt_all_block_headers.all()
        // console.log("stmt_all_block_headers", result)
        // console.log("stmt_all_block_headers.length", result.length)
        for (let row of result) {
            if (burn_blocks_by_burn_header_hash[row.burn_header_hash]) {
                burn_blocks_by_burn_header_hash[row.burn_header_hash].block_headers.push(row)
                stacks_blocks_by_stacks_block_hash[row.block_hash] = row
            }
        }
    }

    function post_process_miner_stats() {
        let total_burn_prev = 0
        for (let blockindex of Object.keys(burn_blocks_by_height)) {
            let block = burn_blocks_by_height[blockindex]
            const total_burn = parseInt(block.total_burn) - total_burn_prev
            block.actual_burn = total_burn
            total_burn_prev = parseInt(block.total_burn)
            for (let block_commit of block.block_commits) {
                if (!miners[block_commit.leader_key_address]) {
                    miners[block_commit.leader_key_address] = {
                        mined: 0,
                        won: 0,
                        burned: 0,
                        total_burn: 0,
                        paid: 0,
                        actual_win: 0,
                        actual_win_bonus: 0
                    }
                }
                const miner = miners[block_commit.leader_key_address]
                miner.mined++
                miner.burned += parseInt(block_commit.burn_fee)
                miner.total_burn += total_burn
                if (block_commit.txid === block.winning_block_txid) {
                    miner.won++
                    win_total++
                }
            }
        }
    }


    function post_process_branches() {
        for (let blockindex of Object.keys(burn_blocks_by_height)) {
            let block = burn_blocks_by_height[blockindex]
            if (block.block_headers.length) {
                block.branch_info = branch_from_parent(block.block_headers[0].block_hash, block.block_headers[0].parent_block)
            }
        }
    }

    function post_process_winning_fork() {
        const sorted_branches = branches.sort((a, b) => a.depth - b.depth)
        const highest_branch = sorted_branches[sorted_branches.length - 1]
        // console.log(highest_branch)
        let current_tip = highest_branch.tip
        while (current_tip !== '0000000000000000000000000000000000000000000000000000000000000000') {
            const stacks_block = stacks_blocks_by_stacks_block_hash[current_tip]
            //console.log(stacks_block)
            const burn_block = burn_blocks_by_burn_header_hash[stacks_block.burn_header_hash]

            blocks_commit_info[burn_block.stacks_block_height] = burn_block.block_commits

            burn_block.on_winning_fork = true
            burn_block.branch_info.winning_fork = true
//console.log(burn_block)
            const winnerIndex = burn_block.block_commits.findIndex(bc => bc.txid === burn_block.winning_block_txid)
            const winner = burn_block.block_commits[winnerIndex]
            winner.stacks_block_height = burn_block.stacks_block_height
            winner.burn_chain_height = burn_block.block_height
            winner.burn_header_timestamp = burn_block.burn_header_timestamp
            winner.winning_block_txid = burn_block.winning_block_txid
            winner.burn_header_hash = burn_block.burn_header_hash

            let payments = burn_block.payments[0]
            //winner.tx_reward = ((parseInt(payments.tx_fees_anchored) + parseInt(payments.tx_fees_streamed)) / 1000000).toFixed(4)
            //winner.block_reward = parseInt(payments.coinbase) / 1000000
            //console.log(winner.tx_reward, payments.tx_fees_anchored, payments.tx_fees_streamed)
            stacks_blocks_by_height.push(winner)
            const winning_miner = miners[winner.leader_key_address]
            winning_miner.actual_win++
            // if (winning_miner.stx_earned === undefined) {
            //     winning_miner.stx_earned = parseFloat(winner.block_reward) + parseFloat(winner.tx_reward)
            // } else {
            //     winning_miner.stx_earned = parseFloat(winning_miner.stx_earned) + parseFloat(winner.block_reward) + parseFloat(winner.tx_reward)
            // }
/*
            if (stacks_block.block_height < 8387)
                winning_miner.actual_win_bonus++

 */
            actual_win_total++
            //console.log(stacks_block.block_height)
            current_tip = stacks_block.parent_block
        }
    }







    let used = process.memoryUsage().heapUsed / 1024 / 1024; console.log(`The script uses approximately ${used} MB`);
    console.log("process_snapshots")
    process_snapshots()
    used = process.memoryUsage().heapUsed / 1024 / 1024; console.log(`The script uses approximately ${used} MB`);
    console.log("process_leader_keys")
    process_leader_keys()
    used = process.memoryUsage().heapUsed / 1024 / 1024; console.log(`The script uses approximately ${used} MB`);
    console.log("process_block_commits")
    process_block_commits()
    used = process.memoryUsage().heapUsed / 1024 / 1024; console.log(`The script uses approximately ${used} MB`);
    console.log("process_block_headers")
    process_block_headers()
    used = process.memoryUsage().heapUsed / 1024 / 1024; console.log(`The script uses approximately ${used} MB`);
    console.log("post_process_block_commits")
    post_process_block_commits()
    used = process.memoryUsage().heapUsed / 1024 / 1024; console.log(`The script uses approximately ${used} MB`);
    console.log("post_process_miner_stats")
    post_process_miner_stats()
    used = process.memoryUsage().heapUsed / 1024 / 1024; console.log(`The script uses approximately ${used} MB`);
    console.log("post_process_branches")
    post_process_branches()
    used = process.memoryUsage().heapUsed / 1024 / 1024; console.log(`The script uses approximately ${used} MB`);
    console.log("post_process_winning_fork")
    post_process_winning_fork()
    used = process.memoryUsage().heapUsed / 1024 / 1024; console.log(`The script uses approximately ${used} MB`);

    let stacks_block_height_max = 0
    let parent_hash = null
    let parent_winner_address = null
    for (let blockindex of Object.keys(burn_blocks_by_height)) {
        let block = burn_blocks_by_height[blockindex]
        let at_tip = ' '
        if (block.payments.length && block.payments[0].stacks_block_height > stacks_block_height_max) {
            stacks_block_height_max = block.payments[0].stacks_block_height
            at_tip = '>'
        }
        const current_winner_address = block.block_commits.find(bc => bc.txid === block.winning_block_txid)
        // const is_argon_or_psq = current_winner_address ? (current_winner_address.leader_key_address === argon_address || current_winner_address.leader_key_address === psq_address) : false

        const stacks_block_id = block.block_headers.length ? Sha512Trunc256Sum(Buffer.from(block.block_headers[0].block_hash, 'hex'), Buffer.from(block.block_headers[0].consensus_hash, 'hex')) : '-'

        parent_winner_address = current_winner_address
        parent_hash = block.block_headers.length ? block.block_headers[0].block_hash : null
    }


    let miners_result = []

    for (let miner_key of Object.keys(miners).sort()) {
        const miner = miners[miner_key]
        //console.log(`${miner_key}/${c32.c32ToB58(miner_key)} ${miner.actual_win}/${miner.won}/${miner.mined} ${(miner.won / miner.mined * 100).toFixed(2)}% ${(miner.actual_win / actual_win_total * 100).toFixed(2)}% - ${miner.burned} - Th[${(miner.burned / miner.total_burn * 100).toFixed(2)}%] (${miner.burned / miner.mined})`)
        miner.average_burn = miner.burned / miner.mined
        miner.normalized_wins = miner.won / miner.average_burn
        const miner_result = {
            stx_address:miner_key,
            btc_address:c32.c32ToB58(miner_key),
            actual_win:miner.actual_win,
            actual_win_bonus: miner.actual_win_bonus,
            total_win:miner.won,
            total_mined: miner.mined,
            miner_burned: miner.burned,
            stx_earned: miner.stx_earned
        }
        miners_result.push(miner_result)
    }
    used = process.memoryUsage().heapUsed / 1024 / 1024; console.log(`The script uses approximately ${used} MB`);
    let stacks_block_results = []
    /*
          winner.stacks_block_height = burn_block.stacks_block_height
          winner.burn_chain_height = burn_block.block_height
          winner.burn_header_timestamp = burn_block.burn_header_timestamp
          winner.winning_block_txid = burn_block.winning_block_txid
          winner.burn_header_hash = burn_block.burn_header_hash
    */
    for (let stacks_block of stacks_blocks_by_height){
        const stacks_block_result = {
            stacks_block_height: stacks_block.stacks_block_height,
            stx_address: stacks_block.leader_key_address,
            btc_address: c32.c32ToB58(stacks_block.leader_key_address),
            burn_fee: stacks_block.burn_fee,
            burn_chain_height: stacks_block.block_height,
            burn_header_timestamp: stacks_block.burn_header_timestamp,
            winning_block_txid: stacks_block.winning_block_txid,
            burn_header_hash: stacks_block.burn_header_hash,
            tx_reward: stacks_block.tx_reward,
            block_reward: stacks_block.block_reward
        }
        stacks_block_results.push(stacks_block_result)
    }

    console.log("================================ Scanning End ================================")

    used = process.memoryUsage().heapUsed / 1024 / 1024; console.log(`The script uses approximately ${used} MB`);
    let a = new Array(1e8).fill("heap test")
    a.reverse()

    used = process.memoryUsage().heapUsed / 1024 / 1024; console.log(`The script uses approximately ${used} MB`);

    console.log("Stacks Chain Length:", stacks_blocks_by_height.length)
    console.log("mining_info length:", stacks_block_results.length)
    let resp =  {miner_info: miners_result, mining_info: stacks_block_results, block_commits: blocks_commit_info}
    console.log(resp)
    return resp
}