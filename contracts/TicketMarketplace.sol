// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./AvaTicket.sol";

/**
 * @title TicketMarketplace
 * @dev Sàn giao dịch sơ cấp và thứ cấp có giá trần (Capped Resale)
 * Atomic Swap: Mint vé + thanh toán trong 1 transaction.
 * Backend (Admin) hoạt động như relayer: gọi hàm thay cho user, record txHash.
 */
contract TicketMarketplace {
    AvaTicket public ticketContract;
    address public admin;

    uint256 public constant PLATFORM_FEE_BPS = 500;  // 5%
    uint256 public constant MAX_MARKUP_BPS  = 11000; // +10% tối đa

    struct ResaleListing {
        uint256  ticketId;
        uint256  resalePrice; // Giá bán lại (VNĐ * 1000)
        address  seller;      // Địa chỉ ví người bán
        bool     active;
    }

    // ticketId => listing
    mapping(uint256 => ResaleListing) public resaleListings;

    // Sự kiện on-chain (phục vụ Snowtrace Explorer demo)
    event TicketBought(
        uint256 indexed ticketId,
        address indexed buyer,
        uint256 eventId,
        uint256 price
    );
    event TicketListedForResale(
        uint256 indexed ticketId,
        address indexed seller,
        uint256 price
    );
    event TicketUnlisted(
        uint256 indexed ticketId,
        address indexed seller
    );
    event ResalePurchased(
        uint256 indexed ticketId,
        address indexed buyer,
        address indexed seller,
        uint256 price
    );
    event TicketScanned(
        uint256 indexed ticketId,
        address indexed scanner,
        uint256 timestamp
    );

    modifier onlyAdmin() {
        require(msg.sender == admin, "Chi Admin duoc goi");
        _;
    }

    constructor(address _ticketContract) {
        ticketContract = AvaTicket(_ticketContract);
        admin = msg.sender;
    }

    /// @notice Mua vé sơ cấp — Backend gọi thay user, truyền địa chỉ ví user
    /// @param buyer   Địa chỉ ví người mua (backend tạo / quản lý)
    /// @param eventId ID sự kiện (đồng bộ với SQLite)
    /// @param price   Giá vé (VNĐ * 1000, integer)
    /// @param seat    Mô tả chỗ ngồi / loại vé
    /// @return ticketId NFT ticket ID vừa được mint
    function buyPrimaryTicket(
        address buyer,
        uint256 eventId,
        uint256 price,
        string memory seat
    ) external onlyAdmin returns (uint256) {
        require(buyer != address(0), "Dia chi buyer khong hop le");
        uint256 ticketId = ticketContract.mint(buyer, eventId, price, seat);
        emit TicketBought(ticketId, buyer, eventId, price);
        return ticketId;
    }

    /// @notice Đăng bán lại vé — Backend gọi, kiểm tra giá trần
    function listResale(
        uint256 ticketId,
        address seller,
        uint256 resalePrice
    ) external onlyAdmin {
        AvaTicket.TicketData memory t = ticketContract.getTicket(ticketId);
        require(t.owner == seller, "Nguoi ban khong so huu ve");
        require(!t.isCheckedIn,  "Ve da check-in, khong the ban lai");
        require(resalePrice > 0, "Gia ban lai phai lon hon 0");
        require(
            resalePrice <= (t.originalPrice * MAX_MARKUP_BPS) / 10000,
            "Chong phe ve: Gia ban lai khong duoc vuot gia goc + 10%!"
        );

        resaleListings[ticketId] = ResaleListing({
            ticketId:    ticketId,
            resalePrice: resalePrice,
            seller:      seller,
            active:      true
        });

        emit TicketListedForResale(ticketId, seller, resalePrice);
    }

    /// @notice Hủy rao bán
    function unlistResale(uint256 ticketId, address seller) external onlyAdmin {
        require(resaleListings[ticketId].active, "Ve khong dang duoc rao ban");
        require(resaleListings[ticketId].seller == seller, "Khong phai nguoi rao ban");
        resaleListings[ticketId].active = false;
        emit TicketUnlisted(ticketId, seller);
    }

    /// @notice Mua vé bán lại — Atomic: chuyển ownership + emit event
    function buyResale(
        uint256 ticketId,
        address buyer
    ) external onlyAdmin {
        ResaleListing storage listing = resaleListings[ticketId];
        require(listing.active,         "Ve khong con duoc rao ban");
        require(buyer != listing.seller, "Khong the tu mua ve cua chinh minh");

        listing.active = false;
        address seller = listing.seller;
        uint256 price  = listing.resalePrice;

        ticketContract.transferOwnership(ticketId, buyer);

        emit ResalePurchased(ticketId, buyer, seller, price);
    }

    /// @notice Soát vé tại cổng (record on-chain + validate QR window)
    function scanTicket(uint256 ticketId, uint256 totpTimestamp) external onlyAdmin {
        ticketContract.checkIn(ticketId, totpTimestamp);
        emit TicketScanned(ticketId, msg.sender, block.timestamp);
    }
}
