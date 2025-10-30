import {useState} from 'react';
import BugReportIcon from '@mui/icons-material/BugReport';
import {submitIssueReport} from '../../services/issuesClient';
import {BugReportModal} from './BugReportModal';
import './feedback.css';

export function BetaFeedbackWidget() {
    const [isModalOpen, setModalOpen] = useState(false);

    return (
        <div className="relative flex items-end">
            <button
                type="button"
                aria-label="Report a bug"
                className="pointer-events-auto flex items-center justify-center rounded-full border border-white/10 bg-black/40 p-2 text-gray-100 shadow-lg transition hover:bg-black/60"
                style={{ cursor: 'pointer' }}
                onClick={() => setModalOpen(true)}
            >
                <BugReportIcon fontSize="small" />
            </button>
            <BugReportModal
                open={isModalOpen}
                onClose={() => setModalOpen(false)}
                onSubmit={submitIssueReport}
            />
        </div>
    );
}
