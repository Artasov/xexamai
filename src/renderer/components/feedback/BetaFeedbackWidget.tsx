import {useState} from 'react';
import BugReportIcon from '@mui/icons-material/BugReport';
import CloseIcon from '@mui/icons-material/Close';
import {submitIssueReport} from '../../services/issuesClient';
import {BugReportModal} from './BugReportModal';
import './feedback.css';

export function BetaFeedbackWidget() {
    const [isInfoVisible, setInfoVisible] = useState(false);
    const [isModalOpen, setModalOpen] = useState(false);

    return (
        <div className="relative flex items-end">
            {isInfoVisible ? (
                <div className="card pointer-events-auto relative z-[3] w-[240px] text-xs text-gray-200">
                    <button
                        type="button"
                        aria-label="Close beta info"
                        className="absolute right-2 top-2 text-gray-400 transition hover:text-gray-100"
                        style={{ cursor: 'pointer' }}
                        onClick={() => setInfoVisible(false)}
                    >
                        <CloseIcon fontSize="small" />
                    </button>
                    <h4 className="mb-1 pr-6 text-sm font-semibold text-gray-100">Beta testing</h4>
                    <p className="mb-3 leading-relaxed text-gray-300">
                        XEXAMAI is currently in beta testing. Found a bug? Please fill out the report form so we can fix
                        it faster.
                    </p>
                    <button
                        type="button"
                        className="btn btn-primary w-full text-sm"
                        style={{ cursor: 'pointer' }}
                        onClick={() => setModalOpen(true)}
                    >
                        Report a bug
                    </button>
                </div>
            ) : (
                <button
                    type="button"
                    aria-label="Report a bug"
                    className="pointer-events-auto flex items-center justify-center rounded-full border border-white/10 bg-black/40 p-2 text-gray-100 shadow-lg transition hover:bg-black/60"
                    style={{ cursor: 'pointer' }}
                    onClick={() => setInfoVisible(true)}
                >
                    <BugReportIcon fontSize="small" />
                </button>
            )}
            <BugReportModal
                open={isModalOpen}
                onClose={() => setModalOpen(false)}
                onSubmit={submitIssueReport}
                onAfterSuccess={() => {
                    setInfoVisible(false);
                }}
            />
        </div>
    );
}
