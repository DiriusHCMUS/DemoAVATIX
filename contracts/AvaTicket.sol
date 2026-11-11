// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title AvaTicket
 * @dev ERC-721 Smart Contract đại diện cho vé sự kiện số hóa trên Avalanche C-Chain
 * Hỗ trợ xác thực mã QR động (TOTP) và trạng thái check-in cổng sự kiện.
 */
contract AvaTicket {
    string public name = "AVA-TIX Event Ticket";
    string public symbol = "AVATIX";

    struct TicketData {
        uint256 eventId;
        uint256 originalPrice; // Giá gốc tính bằng wei hoặc đơn vị tiền quy đổi
        string seatInfo;       // Ví dụ: VIP 1 - Ghế A12
        bool isCheckedIn;      // Trạng thái đã qua cổng chưa
        uint256 checkInTime;   // Thời điểm quét vé
        address owner;
    }

    uint256 public nextTicketId = 1;
    address public marketplace;
    address public admin;

    mapping(uint256 => TicketData) public tickets;
    mapping(address => uint256[]) public ownerTickets;

    event TicketMinted(uint256 indexed ticketId, address indexed to, uint256 eventId, uint256 price);
    event TicketTransferred(uint256 indexed ticketId, address indexed from, address indexed to);
    event TicketCheckedIn(uint256 indexed ticketId, uint256 timestamp, address scanner);

    modifier onlyMarketplace() {
        require(msg.sender == marketplace || msg.sender == admin, "Chi danh cho Marketplace hoac Admin");
        _;
    }

    modifier onlyAdmin() {
        require(msg.sender == admin, "Chi danh cho Admin");
        _;
    }

    constructor() {
        admin = msg.sender;
    }

    function setMarketplace(address _marketplace) external onlyAdmin {
        marketplace = _marketplace;
    }

    function mint(address to, uint256 eventId, uint256 price, string memory seat) external onlyMarketplace returns (uint256) {
        uint256 ticketId = nextTicketId++;
        tickets[ticketId] = TicketData({
            eventId: eventId,
            originalPrice: price,
            seatInfo: seat,
            isCheckedIn: false,
            checkInTime: 0,
            owner: to
        });
        ownerTickets[to].push(ticketId);

        emit TicketMinted(ticketId, to, eventId, price);
        return ticketId;
    }

    function transferOwnership(uint256 ticketId, address to) external onlyMarketplace {
        require(to != address(0), "Dia chi khong hop le");
        TicketData storage t = tickets[ticketId];
        address from = t.owner;
        t.owner = to;
        ownerTickets[to].push(ticketId);

        emit TicketTransferred(ticketId, from, to);
    }

    // Bảo vệ ở cổng quét mã Dynamic QR và xác thực vào cửa
    function checkIn(uint256 ticketId, uint256 totpTimestamp) external onlyAdmin {
        TicketData storage t = tickets[ticketId];
        require(!t.isCheckedIn, "Loi: Ve nay da duoc check-in truoc do!");
        require(block.timestamp >= totpTimestamp, "Timestamp khong hop le");
        require(block.timestamp - totpTimestamp <= 60, "Loi: Ma QR dong da het han (qua 60s)!");

        t.isCheckedIn = true;
        t.checkInTime = block.timestamp;

        emit TicketCheckedIn(ticketId, block.timestamp, msg.sender);
    }

    function getTicket(uint256 ticketId) external view returns (TicketData memory) {
        return tickets[ticketId];
    }
}
